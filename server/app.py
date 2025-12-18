from __future__ import annotations

from flask import Flask, request, Response, redirect
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse, quote, parse_qs, unquote
import os
import hashlib
from datetime import datetime, timedelta, timezone

try:
    from supabase import create_client
except Exception:
    create_client = None

# Create a Flask app without serving static files from this app (we proxy Wikipedia's instead)
app = Flask(__name__, static_folder=None)

# Base domain for the mobile Wikipedia experience; configurable via env
WIKI_BASE = os.environ.get("WIKI_BASE", "https://en.m.wikipedia.org")

# Optional Supabase-backed HTML cache (safe to run without Supabase configured)
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
WIKI_CACHE_TABLE = os.environ.get("WIKI_CACHE_TABLE", "wiki_html_cache")

# Bump this when you change rewrite behavior to effectively bust the cache
CACHE_REWRITE_VERSION = int(os.environ.get("CACHE_REWRITE_VERSION", "1"))

# Adaptive TTL defaults (seconds)
CACHE_TTL_MIN_SECONDS = int(os.environ.get("CACHE_TTL_MIN_SECONDS", "600"))  # 10m
CACHE_TTL_MAX_SECONDS = int(os.environ.get("CACHE_TTL_MAX_SECONDS", "86400"))  # 24h
CACHE_TTL_GROWTH_FACTOR = float(os.environ.get("CACHE_TTL_GROWTH_FACTOR", "2.0"))

supabase = None
if create_client and SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    except Exception:
        supabase = None

# Wikimedia/Wikipedia allowlist (prevents SSRF + avoids caching arbitrary hosts)
_WIKIMEDIA_APEX = (
    "wikipedia.org",
    "wiktionary.org",
    "wikidata.org",
    "wikimedia.org",
    "wikibooks.org",
    "wikiquote.org",
    "wikiversity.org",
    "wikivoyage.org",
    "wikisource.org",
    "wikinews.org",
    "mediawiki.org",
)


def is_allowed_wikimedia_host(host: str) -> bool:
    if not host:
        return False
    h = host.lower().strip()
    # Strip port if present
    if ":" in h:
        h = h.split(":", 1)[0]
    if h in ("commons.wikimedia.org", "upload.wikimedia.org"):
        return True
    for apex in _WIKIMEDIA_APEX:
        if h == apex or h.endswith("." + apex):
            return True
    return False


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def to_iso8601_z(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def parse_iso8601(dt_str: str | None) -> datetime | None:
    if not dt_str:
        return None
    s = dt_str.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def lang_key_from_accept_language(header_val: str | None) -> str:
    if not header_val:
        return "en"
    first = header_val.split(",", 1)[0].strip()
    if not first:
        return "en"
    tag = first.split(";", 1)[0].strip().lower()
    return tag or "en"


def canonicalize_url_for_cache(url: str) -> str:
    try:
        p = urlparse(url)
        return p._replace(fragment="").geturl()
    except Exception:
        return url


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def compute_cache_key(url: str, lang_key: str) -> str:
    canonical = canonicalize_url_for_cache(url)
    material = f"v{CACHE_REWRITE_VERSION}|{lang_key}|{canonical}"
    return sha256_hex(material)


def is_cacheable_html_target(parsed) -> bool:
    """Heuristic to avoid DB lookups for obvious asset URLs."""
    path = (parsed.path or "").strip()
    if path == "" or path == "/":
        return True
    if path.startswith("/wiki/"):
        return True
    if path == "/w/index.php":
        return True
    return False


def next_ttl_seconds(current_ttl_seconds: int | None, can_grow: bool) -> int:
    if not can_grow:
        return CACHE_TTL_MIN_SECONDS
    cur = current_ttl_seconds or 0
    if cur <= 0:
        cur = CACHE_TTL_MIN_SECONDS
    grown = int(cur * CACHE_TTL_GROWTH_FACTOR)
    if grown <= cur:
        grown = cur + CACHE_TTL_MIN_SECONDS
    if grown < CACHE_TTL_MIN_SECONDS:
        grown = CACHE_TTL_MIN_SECONDS
    if grown > CACHE_TTL_MAX_SECONDS:
        grown = CACHE_TTL_MAX_SECONDS
    return grown


def cache_get(cache_key: str) -> dict | None:
    if not supabase:
        return None
    try:
        resp = (
            supabase.table(WIKI_CACHE_TABLE)
            .select("*")
            .eq("cache_key", cache_key)
            .limit(1)
            .execute()
        )
        data = getattr(resp, "data", None) or []
        if not data:
            return None
        return data[0]
    except Exception:
        return None


def cache_upsert(row: dict) -> None:
    if not supabase:
        return
    try:
        supabase.table(WIKI_CACHE_TABLE).upsert(row).execute()
    except Exception:
        # Cache failures should never break page rendering
        return


def absolutize(url_or_path: str) -> str:
    # Gracefully handle empty/None inputs
    if not url_or_path:
        return WIKI_BASE
    # Resolve relative paths against the mobile wikipedia base
    return urljoin(WIKI_BASE, url_or_path)


def make_proxy_url(target_abs_url: str) -> str:
    # Wrap an absolute URL into our HTML proxy endpoint
    return f"/m?url={quote(target_abs_url, safe='')}"


def make_image_proxy_url(target_abs_url: str) -> str:
    # Wrap an absolute image/media URL into our image proxy endpoint
    return f"/i?url={quote(target_abs_url, safe='')}"


def rewrite_links(html: str, base_url: str) -> str:
    # Parse upstream HTML for rewriting
    soup = BeautifulSoup(html, "html.parser")

    # Remove/neutralize tags/headers that can interfere with embedding/proxying.
    # - Content-Security-Policy/X-Frame-Options in meta tags can block our injection/iframes.
    # NOTE: This only removes meta tags in HTML, not HTTP response headers.
    for meta in soup.find_all("meta", attrs={"http-equiv": True}):
        v = (meta.get("http-equiv") or "").lower()
        if v in ("content-security-policy", "x-frame-options", "refresh"):
            meta.decompose()

    # A <base> tag can change how relative URLs resolve; remove to ensure our own resolution
    for base in soup.find_all("base"):
        base.decompose()

    # Helper to rewrite a URL attribute (e.g., href/src) to our /m proxy URL
    def rewrite_attr(tag, attr):
        val = tag.get(attr)
        if not val:
            return
        v = val.strip()
        # Ignore anchors, data URLs, and javascript: URLs
        if v.startswith("#") or v.startswith("data:") or v.startswith("javascript:"):
            return
        # Some assets are hosted on desktop domain, not mobile; normalize those
        if v.startswith("/static/"):
            abs_url = urljoin("https://en.wikipedia.org/", v)
        else:
            abs_url = urljoin(base_url, v)
        tag[attr] = make_proxy_url(abs_url)

    # Helper to rewrite a srcset attribute while preserving density/width descriptors
    def rewrite_srcset(tag, attr):
        srcset = tag.get(attr)
        if not srcset:
            return
        parts = [p.strip() for p in srcset.split(",")]
        new_parts = []
        for p in parts:
            segs = p.split()
            if not segs:
                continue
            u = segs[0]
            # Preserve non-network URLs as-is
            if (
                u.startswith("#")
                or u.startswith("data:")
                or u.startswith("javascript:")
            ):
                new_parts.append(p)
                continue
            abs_url = urljoin(base_url, u)
            segs[0] = make_proxy_url(abs_url)
            new_parts.append(" ".join(segs))
        tag[attr] = ", ".join(new_parts)

    # Rewrite anchors:
    # - Skip image/media links so Wikipedia's own overlay continues to work
    for a in soup.find_all("a", href=True):
        href = (a.get("href") or "").strip()
        if not href or href.startswith("#"):
            continue

        # Skip rewriting image/media links so Wikipedia's overlay handles them
        classes = a.get("class") or []
        contains_img = a.find("img") is not None

        abs_href = urljoin(base_url, href)
        p = urlparse(abs_href)
        path = p.path or ""
        is_file_like = (
            path.startswith("/wiki/File:")
            or path.startswith("/wiki/Media:")
            or "/wiki/Special:FilePath/" in path
        )
        has_image_class = any(
            c in ("image", "thumb", "thumbimage", "mwe-image", "mw-file-description")
            for c in classes
        )

        if (
            contains_img
            or is_file_like
            or has_image_class
            or a.get("data-file") is not None
        ):
            # Leave as-is; Wikipedia will handle image overlays natively
            continue

        # For non-image anchors, route through our /m proxy
        a["href"] = make_proxy_url(abs_href)

    # Stylesheets, icons, manifests → rewrite link hrefs
    for link in soup.find_all("link", href=True):
        rewrite_attr(link, "href")

    # External scripts → rewrite src
    for s in soup.find_all("script", src=True):
        rewrite_attr(s, "src")

    # Images/media: leave their external absolute URLs untouched for Wikipedia's overlay,
    # but normalize absolute Wikipedia static URLs to our /static/* passthrough.
    # This keeps native lazy-loading/overlays working while letting us proxy through /static.

    # Normalize absolute wikipedia static asset URLs to our /static/* passthrough
    def normalize_static_url(url_val: str) -> str | None:
        if not url_val:
            return None
        v = url_val.strip()
        # Already a root-relative /static/... -> our /static route will proxy it
        if v.startswith("/static/"):
            return v
        # protocol-relative
        if v.startswith("//"):
            parsed = urlparse("https:" + v)
        else:
            parsed = urlparse(v)
        host = (parsed.netloc or "").lower()
        if host in ("en.wikipedia.org", "www.wikipedia.org") and (
            parsed.path or ""
        ).startswith("/static/"):
            return parsed.path + ("?" + parsed.query if parsed.query else "")
        return None

    # Normalize srcset values with /static/ mapping when possible
    def normalize_srcset_value(srcset_val: str) -> str:
        if not srcset_val:
            return srcset_val
        parts = [p.strip() for p in srcset_val.split(",")]
        out = []
        for p in parts:
            segs = p.split()
            if not segs:
                continue
            maybe = normalize_static_url(segs[0])
            if maybe:
                segs[0] = maybe
            out.append(" ".join(segs))
        return ", ".join(out)

    # Apply normalization on <img> tags
    for img in soup.find_all("img"):
        new_src = normalize_static_url(img.get("src"))
        if new_src:
            img["src"] = new_src
        if img.get("srcset"):
            img["srcset"] = normalize_srcset_value(img.get("srcset"))

    # Apply normalization on <source> tags (e.g., <picture>, audio/video sources)
    for src in soup.find_all(["source"]):
        new_src = normalize_static_url(src.get("src"))
        if new_src:
            src["src"] = new_src
        if src.get("srcset"):
            src["srcset"] = normalize_srcset_value(src.get("srcset"))

    # Apply normalization on <video>/<audio> elements' src
    for tag in soup.find_all(["video", "audio"]):
        new_src = normalize_static_url(tag.get("src"))
        if new_src:
            tag["src"] = new_src

    # Rewrite form actions (e.g., search forms) to route submissions back through our proxy
    for f in soup.find_all("form"):
        action = f.get("action")
        if action:
            f["action"] = make_proxy_url(urljoin(base_url, action))

    # Inject a script to:
    # - Intercept link clicks: open Wikimedia domains in a new proxied iframe; external links in new tab
    # - Relay double-click and pinch/zoom gestures to the parent window (for embedding control)
    inject = soup.new_tag("script")
    inject.string = """
(function(){
	// Intercept link clicks: Wikimedia → new iframe; others → new tab
	(function(){
		function getOriginalHref(a){
			var href = a.getAttribute('href') || '';
			if(!href) return '';
			// Prefer absolute href when available
			var abs = a.href || href;
			// Unwrap proxied /m?url=...
			var m = abs.match(/[?&]url=([^&]+)/);
			if(m) return decodeURIComponent(m[1]);
			return abs;
		}
		function isWikimediaHost(host){
			if(!host) return false;
			host = host.toLowerCase();
			var apex = [
				'wikipedia.org','wiktionary.org','wikidata.org','wikimedia.org','wikibooks.org',
				'wikiquote.org','wikiversity.org','wikivoyage.org','wikisource.org','wikinews.org',
				'mediawiki.org'
			];
			if (host === 'commons.wikimedia.org' || host === 'upload.wikimedia.org') return true;
			for (var i=0;i<apex.length;i++){
				if (host === apex[i] || host.endsWith('.' + apex[i])) return true;
			}
			return false;
		}
		function handleAnchorEvent(e){
			var a = e.target && e.target.closest && e.target.closest('a[href]');
			if(!a) return;
			var attrHref = a.getAttribute('href') || '';
			if(!attrHref || attrHref[0] === '#') return;
			// Skip image/media links so Wikipedia's overlay handles them
			var containsImg = (e.target && e.target.tagName === 'IMG') || (a.querySelector && a.querySelector('img'));
			var isImageLink = a.classList && (a.classList.contains('image') || a.classList.contains('thumb') || a.classList.contains('thumbimage') || a.classList.contains('mwe-image'));
			var original = getOriginalHref(a);
			if(!original) return;
			var isFileLike = (/(\/(wiki|w)\/|[?&]title=)(File|Media):/i).test(original) || (/\/wiki\/Special:FilePath\//i).test(original);
			if (containsImg || isImageLink || isFileLike || a.getAttribute('data-file') != null) return;

			var host = '';
			try { host = new URL(original, location.href).host; } catch(_) {}

			// Wikimedia/Wikipedia → post to parent to create new iframe alongside
			if (isWikimediaHost(host)) {
				e.preventDefault();
				try { parent && parent.postMessage({ type: 'wiki-link', href: original, sourceId: window.name || null }, '*'); } catch(_) {}
				return;
			}

			// Non-Wikimedia → open original URL in a new tab (bypass proxy)
			e.preventDefault();
			try { window.open(original, '_blank', 'noopener,noreferrer'); } catch(_) {}
		}
		document.addEventListener('click', handleAnchorEvent, true);
		document.addEventListener('auxclick', function(e){ if (e.button === 1) handleAnchorEvent(e); }, true);
	})();

	// Double-click anywhere in the page -> ask parent to zoom to this iframe
	document.addEventListener('dblclick', function(){
		try {
			parent && parent.postMessage({ type: 'iframe-dblclick', sourceId: window.name || null }, '*');
		} catch(_) {}
	}, { passive: true });

	// Post a normalized zoom message to the parent
	function postZoom(payload){
		try { parent && parent.postMessage(Object.assign({ type: 'iframe-zoom', sourceId: window.name || null }, payload), '*'); } catch(_) {}
	}

	// Chrome/Firefox/etc: pinch triggers a ctrl+wheel
	document.addEventListener('wheel', function(e){
		if(!e.ctrlKey) return;
		e.preventDefault();
		postZoom({ deltaY: e.deltaY, clientX: e.clientX, clientY: e.clientY });
	}, { passive: false });

	// Safari/iOS: gesture* events
	var _lastScale = 1;
	document.addEventListener('gesturestart', function(e){
		_lastScale = e.scale || 1;
		e.preventDefault();
	}, { passive: false });

	document.addEventListener('gesturechange', function(e){
		var scale = e.scale || 1;
		var ds = scale - _lastScale; // positive when zooming in
		_lastScale = scale;
		var deltaY = -ds * 240; // approximate wheel delta
		e.preventDefault();
		postZoom({
			deltaY: deltaY,
			clientX: (typeof e.clientX === 'number' ? e.clientX : window.innerWidth / 2),
			clientY: (typeof e.clientY === 'number' ? e.clientY : window.innerHeight / 2)
		});
	}, { passive: false });

	document.addEventListener('gestureend', function(e){
		e.preventDefault();
	}, { passive: false });
})();
""".strip()
    # Append the injected script as the last element in <body>, else fallback to <head>, else root
    if soup.body:
        soup.body.append(inject)
    else:
        if soup.head:
            soup.head.append(inject)
        else:
            soup.append(inject)

    # Return the modified HTML as a string
    return str(soup)


def unwrap_proxy_url(url: str) -> str:
    """If the given URL points back to this proxy (\n/m or /i with nested url/path), unwrap it.
    Limits unwrapping to a small number of iterations to avoid loops."""
    # Prevent infinite loops by limiting nested unwrap attempts
    MAX_HOPS = 8
    current = url
    for _ in range(MAX_HOPS):
        p = urlparse(current)
        # Only unwrap http(s) URLs
        if p.scheme not in ("http", "https"):
            break
        # Compare against the host that handled this request
        # NOTE: request.host originates from the Host header; behind proxies this can vary.
        if p.netloc != request.host:
            # Allow common local dev host aliases (localhost vs 127.0.0.1) with same port
            try:

                def _split_netloc(netloc: str):
                    nl = netloc.strip()
                    if nl.startswith("["):
                        # IPv6: [::1]:5000
                        host_part, _, rest = nl[1:].partition("]")
                        port_part = None
                        if rest.startswith(":"):
                            port_part = rest[1:]
                        return host_part, port_part
                    if ":" in nl:
                        h, p2 = nl.rsplit(":", 1)
                        return h, p2
                    return nl, None

                a_host, a_port = _split_netloc(p.netloc or "")
                b_host, b_port = _split_netloc(request.host or "")
                loopbacks = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}
                if not (
                    (a_port == b_port)
                    and (a_host.lower() in loopbacks)
                    and (b_host.lower() in loopbacks)
                ):
                    break
            except Exception:
                break
        path = p.path or ""
        # Some callers accidentally double-encode the query string, e.g. "url%3Dhttps%253A..."
        # In that case parse_qs won't see the url/path params. Try to decode once and re-parse.
        qs = parse_qs(p.query or "")
        if (
            ("url" not in qs and "path" not in qs)
            and p.query
            and ("%3D" in p.query or "%26" in p.query)
        ):
            try:
                decoded_q = unquote(p.query)
                qs2 = parse_qs(decoded_q or "")
                if "url" in qs2 or "path" in qs2:
                    qs = qs2
            except Exception:
                pass
        # Rare case: query parsed as a single key containing "url=<...>" because '=' was encoded
        if ("url" not in qs and "path" not in qs) and len(qs) == 1:
            only_key = next(iter(qs.keys()))
            if isinstance(only_key, str) and (
                "url=" in only_key or "path=" in only_key
            ):
                try:
                    if only_key.startswith("url="):
                        qs = {"url": [only_key.split("=", 1)[1]]}
                    elif only_key.startswith("path="):
                        qs = {"path": [only_key.split("=", 1)[1]]}
                except Exception:
                    pass
        if path == "/m":
            inner = qs.get("url", [None])[0]
            if inner:
                current = inner
                continue
            inner_path = qs.get("path", [None])[0]
            if inner_path:
                current = absolutize(inner_path)
                continue
            break
        elif path == "/i":
            inner = qs.get("url", [None])[0]
            if inner:
                current = inner
                continue
            break
        else:
            break
    return current


@app.route("/")
def root():
    # Convenience redirect to a known page to boot the experience quickly
    return redirect("/m?path=/wiki/The_Simpsons", code=302)


@app.route("/m")
def mobile():
    # HTML proxy endpoint.
    # Accept either ?url=... (absolute/possibly proxied URL) or ?path=/wiki/... (relative path)
    raw_url = request.args.get("url")
    path = request.args.get("path")

    if raw_url:
        # If a relative path slipped into url=..., treat it like path
        if raw_url.startswith("/"):
            target = absolutize(raw_url)
        else:
            # Unwrap if the client accidentally sent our own /m or /i URL
            target = unwrap_proxy_url(raw_url)
    elif path:
        # Build absolute target from a relative wiki path
        target = absolutize(path)
    else:
        # Default to mobile Wikipedia home
        target = WIKI_BASE

    # Only allow http(s) fetches
    parsed = urlparse(target)
    if parsed.scheme not in ("http", "https"):
        return Response("Invalid scheme.", status=400)
    # Prevent SSRF / caching arbitrary hosts
    if not is_allowed_wikimedia_host(parsed.netloc):
        return Response("Host not allowed.", status=403)

    lang_key = lang_key_from_accept_language(request.headers.get("Accept-Language"))
    canonical_target = canonicalize_url_for_cache(target)

    # Fetch from upstream with browser-like headers to mimic a real browser.
    # Prefer the client's Accept header so asset requests (css/js) behave correctly.
    upstream_headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": request.headers.get(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        ),
        "Accept-Language": request.headers.get("Accept-Language", "en-US,en;q=0.9"),
    }

    now = utcnow()
    wants_cache = bool(supabase) and is_cacheable_html_target(parsed)
    cache_key = compute_cache_key(canonical_target, lang_key) if wants_cache else None
    entry = cache_get(cache_key) if (wants_cache and cache_key) else None

    def html_response(body: str, status: int, cache_state: str | None = None):
        headers = {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
        }
        if cache_state:
            headers["X-WikiPro-Cache"] = cache_state
        return Response(body, status=status, headers=headers)

    # Fresh cache hit
    if entry and entry.get("body") and entry.get("next_refresh_at"):
        next_refresh = parse_iso8601(entry.get("next_refresh_at"))
        if next_refresh and now < next_refresh:
            return html_response(
                entry.get("body") or "",
                int(entry.get("status") or 200),
                "HIT",
            )

    # Stale cache entry → conditional revalidate (serve stale on error)
    if entry and entry.get("body"):
        conditional_headers = dict(upstream_headers)
        if entry.get("etag"):
            conditional_headers["If-None-Match"] = entry.get("etag")
        if entry.get("last_modified"):
            conditional_headers["If-Modified-Since"] = entry.get("last_modified")

        try:
            resp = requests.get(target, headers=conditional_headers, timeout=15)
        except requests.RequestException:
            # Can't reach upstream; serve stale cache
            return html_response(
                entry.get("body") or "",
                int(entry.get("status") or 200),
                "STALE",
            )

        content_type = resp.headers.get("Content-Type", "")

        # Upstream unchanged
        if resp.status_code == 304:
            cached_status = int(entry.get("status") or 200)
            can_grow = cached_status == 200
            ttl = next_ttl_seconds(entry.get("ttl_seconds"), can_grow=can_grow)
            next_refresh_at = now + timedelta(seconds=ttl)

            row = {
                "cache_key": cache_key,
                "url": canonical_target,
                "lang_key": lang_key,
                "rewrite_version": CACHE_REWRITE_VERSION,
                "status": cached_status,
                "content_type": entry.get("content_type") or "text/html; charset=utf-8",
                "body": entry.get("body") or "",
                "body_sha256": entry.get("body_sha256")
                or sha256_hex(entry.get("body") or ""),
                "etag": resp.headers.get("ETag") or entry.get("etag"),
                "last_modified": resp.headers.get("Last-Modified")
                or entry.get("last_modified"),
                "ttl_seconds": ttl,
                "next_refresh_at": to_iso8601_z(next_refresh_at),
                "fetched_at": entry.get("fetched_at") or to_iso8601_z(now),
                "last_checked_at": to_iso8601_z(now),
                "last_changed_at": entry.get("last_changed_at")
                or (entry.get("fetched_at") or to_iso8601_z(now)),
            }
            cache_upsert(row)
            return html_response(entry.get("body") or "", cached_status, "REVALIDATED")

        # If it isn't HTML, just stream it through unchanged (don't cache in DB)
        if "text/html" not in content_type:
            return Response(
                resp.content,
                status=resp.status_code,
                headers={
                    "Content-Type": content_type or "application/octet-stream",
                    "Cache-Control": "no-store",
                },
            )

        replaced = rewrite_links(resp.text, base_url=target)
        body_hash = sha256_hex(replaced)
        cached_hash = entry.get("body_sha256")
        unchanged = (
            resp.status_code == 200
            and int(entry.get("status") or 0) == 200
            and bool(cached_hash)
            and body_hash == cached_hash
        )
        ttl = next_ttl_seconds(entry.get("ttl_seconds"), can_grow=unchanged)
        if not unchanged:
            ttl = CACHE_TTL_MIN_SECONDS
        next_refresh_at = now + timedelta(seconds=ttl)

        row = {
            "cache_key": cache_key,
            "url": canonical_target,
            "lang_key": lang_key,
            "rewrite_version": CACHE_REWRITE_VERSION,
            "status": int(resp.status_code),
            "content_type": "text/html; charset=utf-8",
            "body": replaced,
            "body_sha256": body_hash,
            "etag": resp.headers.get("ETag"),
            "last_modified": resp.headers.get("Last-Modified"),
            "ttl_seconds": ttl,
            "next_refresh_at": to_iso8601_z(next_refresh_at),
            "fetched_at": to_iso8601_z(now),
            "last_checked_at": to_iso8601_z(now),
            "last_changed_at": (
                entry.get("last_changed_at") if unchanged else to_iso8601_z(now)
            ),
        }
        cache_upsert(row)
        return html_response(
            replaced,
            int(resp.status_code),
            "UNCHANGED" if unchanged else "REFRESH",
        )

    # Cache miss (or cache disabled): fetch normally
    try:
        resp = requests.get(target, headers=upstream_headers, timeout=15)
    except requests.RequestException as e:
        # Upstream network/timeout error → 502 Bad Gateway
        return Response(f"Upstream fetch error: {e}", status=502)

    content_type = resp.headers.get("Content-Type", "")
    if "text/html" not in content_type:
        # For non-HTML (images/css/js), just stream it through unchanged.
        # NOTE: This makes /m behave as a generic proxy if non-HTML is requested via ?url=...
        return Response(
            resp.content,
            status=resp.status_code,
            headers={
                "Content-Type": content_type or "application/octet-stream",
                "Cache-Control": "no-store",
            },
        )

    replaced = rewrite_links(resp.text, base_url=target)

    # Store new entry with MIN TTL
    if wants_cache and cache_key:
        ttl = CACHE_TTL_MIN_SECONDS
        next_refresh_at = now + timedelta(seconds=ttl)
        row = {
            "cache_key": cache_key,
            "url": canonical_target,
            "lang_key": lang_key,
            "rewrite_version": CACHE_REWRITE_VERSION,
            "status": int(resp.status_code),
            "content_type": "text/html; charset=utf-8",
            "body": replaced,
            "body_sha256": sha256_hex(replaced),
            "etag": resp.headers.get("ETag"),
            "last_modified": resp.headers.get("Last-Modified"),
            "ttl_seconds": ttl,
            "next_refresh_at": to_iso8601_z(next_refresh_at),
            "fetched_at": to_iso8601_z(now),
            "last_checked_at": to_iso8601_z(now),
            "last_changed_at": to_iso8601_z(now),
        }
        cache_upsert(row)

    return html_response(
        replaced, int(resp.status_code), "MISS" if wants_cache else None
    )


@app.route("/<path:path>")
def passthrough(path: str):
    # Generic passthrough for asset-like paths such as /w/load.php, /static/..., etc.
    # Preserves the original query string.
    # Special-case /static/* which lives on the desktop domain instead of mobile.
    if path.startswith("static/"):
        base = urljoin("https://en.wikipedia.org/", "/" + path)
    else:
        base = absolutize("/" + path)
    qs = request.query_string.decode() if request.query_string else ""
    target = base + (("?" + qs) if qs else "")

    headers = {
        "User-Agent": "wikipedia-proxy/0.1 (+https://example.local)",
        "Accept": request.headers.get("Accept", "*/*"),
        "Referer": request.headers.get("Referer", ""),
    }
    try:
        resp = requests.get(target, headers=headers, timeout=15)
    except requests.RequestException as e:
        return Response(f"Upstream fetch error: {e}", status=502)

    return Response(
        resp.content,
        status=resp.status_code,
        headers={
            "Content-Type": resp.headers.get(
                "Content-Type", "application/octet-stream"
            ),
            "Cache-Control": "no-store",
        },
    )


@app.route("/i")
def proxy_image():
    # Streams any absolute image URL (?url=https://...), unwrapping nested self-proxy URLs first
    raw_url = request.args.get("url")
    if not raw_url:
        return Response("Missing url", status=400)
    # Unwrap nested proxy URLs if they point back to us
    raw_url = unwrap_proxy_url(raw_url)
    parsed = urlparse(raw_url)
    if parsed.scheme not in ("http", "https"):
        return Response("Invalid scheme", status=400)
    if not is_allowed_wikimedia_host(parsed.netloc):
        return Response("Host not allowed", status=403)

    headers = {
        "User-Agent": "wikipedia-proxy/0.1 (+https://example.local)",
        "Accept": request.headers.get("Accept", "image/*,*/*"),
    }
    try:
        resp = requests.get(raw_url, headers=headers, timeout=20)
    except requests.RequestException as e:
        return Response(f"Upstream fetch error: {e}", status=502)

    return Response(
        resp.content,
        status=resp.status_code,
        headers={
            "Content-Type": resp.headers.get(
                "Content-Type", "application/octet-stream"
            ),
            "Cache-Control": "no-store",
        },
    )


@app.route("/static/<path:path>")
def proxy_static(path: str):
    # Direct mapping for /static/* assets to the desktop Wikipedia domain (not mobile)
    qs = request.query_string.decode() if request.query_string else ""
    target = urljoin("https://en.wikipedia.org/", f"/static/{path}") + (
        ("?" + qs) if qs else ""
    )

    headers = {
        "User-Agent": "wikipedia-proxy/0.1 (+https://example.local)",
        "Accept": request.headers.get("Accept", "*/*"),
    }
    try:
        resp = requests.get(target, headers=headers, timeout=20)
    except requests.RequestException as e:
        return Response(f"Upstream fetch error: {e}", status=502)

    return Response(
        resp.content,
        status=resp.status_code,
        headers={
            "Content-Type": resp.headers.get(
                "Content-Type", "application/octet-stream"
            ),
            "Cache-Control": "no-store",
        },
    )
