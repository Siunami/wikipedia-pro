import {
	Tldraw,
	BaseBoxShapeUtil,
	HTMLContainer,
	T,
	createShapeId,
	type TLBaseShape,
	useEditor,
} from "tldraw";
import "tldraw/tldraw.css";
import { useEffect, useRef, useState } from "react";

// Map a child window (iframe contentWindow) back to the shape id that hosts it
const contentWindowToShapeId = new Map<Window, string>();

// Prevent duplicate creations from closely-timed duplicate messages
const recentlyHandled = new Map<string, number>();

// Global dimensions for all iframe shapes
const IFRAME_W = 640;
const IFRAME_H = 800;

// Dimensions for the temporary in-canvas Wikipedia search bar
const SEARCH_W = 500;
const SEARCH_BAR_H = 52; // compact height (just the bar)
const RESULT_ROW_H = 40; // button row height
const RESULTS_MAX_H = 360; // cap for results area

type BoundsLike = { x: number; y: number; w: number; h: number };

// Guarded diagnostics for deletion flow
const DEBUG_DELETE_ARROWS = false;

// Track relationships between frames and arrows so we can clean up reliably
const frameIdToArrowIds = new Map<string, Set<string>>();
const arrowIdToFrameIds = new Map<string, { from?: string; to?: string }>();

const localHostUrl = "http://127.0.0.1:5000";
const serverURL = "https://server-flax-ten-71.vercel.app";

const baseUrl = import.meta.env.DEV ? localHostUrl : serverURL;

// Z-order normalization: ensure iframes above arrows
let normalizeRaf: number | null = null;
let normalizeTimeout: number | null = null;
function doNormalizeZOrder(editor: any) {
	try {
		const shapes = editor.getCurrentPageShapes();
		const arrowIds = shapes
			.filter((s: any) => s.type === "arrow")
			.map((s: any) => s.id);
		const iframeIds = shapes
			.filter((s: any) => s.type === "iframe")
			.map((s: any) => s.id);
		const searchIds = shapes
			.filter((s: any) => s.type === "wikibar")
			.map((s: any) => s.id);
		if (arrowIds.length) editor.sendToBack(arrowIds);
		const frontIds = [...iframeIds, ...searchIds];
		if (frontIds.length) editor.bringToFront(frontIds);
	} catch {}
}
function scheduleNormalizeZOrder(editor: any) {
	if (normalizeRaf != null) cancelAnimationFrame(normalizeRaf);
	if (normalizeTimeout != null) clearTimeout(normalizeTimeout);
	normalizeRaf = requestAnimationFrame(() => {
		normalizeRaf = null;
		doNormalizeZOrder(editor);
	});
	normalizeTimeout = window.setTimeout(() => {
		normalizeTimeout = null;
		doNormalizeZOrder(editor);
	}, 80);
}

function focusBounds(
	editor: any,
	bounds: BoundsLike,
	options: { minZoom?: number; maxZoom?: number; bump?: number; duration?: number } = {}
) {
	const { minZoom = 1.1, maxZoom = 2.6, bump = 1.25, duration = 260 } = options;
	if (!editor) return;

	const currentZoom =
		typeof editor.getZoomLevel === "function" ? editor.getZoomLevel() : 1;
	const zoomBase = Math.max(currentZoom, minZoom);
	const targetZoom = Math.min(maxZoom, zoomBase * bump);

	try {
		// @ts-ignore - tldraw accepts plain bounds objects
		editor.zoomToBounds(bounds, { targetZoom, animation: { duration } });
	} catch {
		try {
			const cx = bounds.x + bounds.w / 2;
			const cy = bounds.y + bounds.h / 2;
			editor.setCamera?.({ x: cx, y: cy, z: targetZoom });
		} catch {}
	}
}

function linkArrowToFrame(frameId: string, arrowId: string) {
	let set = frameIdToArrowIds.get(frameId);
	if (!set) {
		set = new Set<string>();
		frameIdToArrowIds.set(frameId, set);
	}
	set.add(arrowId);
}

function unlinkArrowFromFrames(arrowId: string) {
	const rel = arrowIdToFrameIds.get(arrowId);
	if (!rel) return;
	if (rel.from) {
		const set = frameIdToArrowIds.get(rel.from);
		if (set) {
			set.delete(arrowId);
			if (set.size === 0) frameIdToArrowIds.delete(rel.from);
		}
	}
	if (rel.to) {
		const set = frameIdToArrowIds.get(rel.to);
		if (set) {
			set.delete(arrowId);
			if (set.size === 0) frameIdToArrowIds.delete(rel.to);
		}
	}
	arrowIdToFrameIds.delete(arrowId);
}

// Unlock and delete a set of arrow shapes by id
function unlockAndDeleteArrows(editor: any, arrowIds: string[] | Set<string>) {
	const idsArr = Array.from(arrowIds);
	if (idsArr.length === 0) return;

	const doDelete = (ids: any[]) => {
		try {
			if (typeof editor.batch === "function") {
				editor.batch(() => {
					try {
						editor.updateShapes(
							ids.map((id) => ({ id, type: "arrow", isLocked: false })) as any
						);
					} catch (err) {
						if (DEBUG_DELETE_ARROWS)
							console.warn("unlockAndDeleteArrows: unlock failed", err);
					}
					try {
						editor.deleteShapes(ids as any);
					} catch (err) {
						if (DEBUG_DELETE_ARROWS)
							console.warn("unlockAndDeleteArrows: delete failed", err);
					}
				});
			} else {
				try {
					editor.updateShapes(
						ids.map((id) => ({ id, type: "arrow", isLocked: false })) as any
					);
				} catch (err) {
					if (DEBUG_DELETE_ARROWS)
						console.warn("unlockAndDeleteArrows: unlock failed", err);
				}
				try {
					editor.deleteShapes(ids as any);
				} catch (err) {
					if (DEBUG_DELETE_ARROWS)
						console.warn("unlockAndDeleteArrows: delete failed", err);
				}
			}
		} catch (err) {
			if (DEBUG_DELETE_ARROWS)
				console.warn("unlockAndDeleteArrows: batch failed", err);
		}
	};

	// First attempt
	doDelete(idsArr as any);

	// One-microtask retry to handle binding/transaction settling without a visual frame
	queueMicrotask(() => {
		const remaining = idsArr.filter((id) => {
			try {
				return Boolean(editor.getShape?.(id));
			} catch {
				return true;
			}
		});

		if (remaining.length > 0) doDelete(remaining as any);

		// Relationship cleanup only for actually-removed arrows
		for (const id of idsArr) {
			let exists = true;
			try {
				exists = Boolean(editor.getShape?.(id));
			} catch {
				exists = true;
			}
			if (!exists) unlinkArrowFromFrames(id);
		}
	});
}

// Schedule a one-per-frame orphan sweep after any store change
let sweepRaf: number | null = null;
let sweepTimeout: number | null = null;
function scheduleSweep(editor: any) {
	if (sweepRaf != null) cancelAnimationFrame(sweepRaf);
	if (sweepTimeout != null) clearTimeout(sweepTimeout);
	sweepRaf = requestAnimationFrame(() => {
		sweepRaf = null;
		sweepOrphanArrows(editor);
	});
	// Fallback sweep shortly after, in case bindings settle a tick later
	sweepTimeout = window.setTimeout(() => {
		sweepTimeout = null;
		sweepOrphanArrows(editor);
	}, 80);
}

// Remove any arrows that are not bound to two iframe shapes
function sweepOrphanArrows(editor: any) {
	const arrows = editor
		.getCurrentPageShapes()
		.filter((s: any) => s.type === "arrow");

	const toDelete: string[] = [];
	for (const a of arrows) {
		try {
			const bindings = editor.getBindingsFromShape(a.id, "arrow") as any[];
			const startB = bindings.find((b: any) => b.props?.terminal === "start");
			const endB = bindings.find((b: any) => b.props?.terminal === "end");
			const startShape = startB
				? (editor.getShape(startB.toId as any) as any)
				: null;
			const endShape = endB ? (editor.getShape(endB.toId as any) as any) : null;
			if (
				!startShape ||
				!endShape ||
				startShape.type !== "iframe" ||
				endShape.type !== "iframe"
			) {
				toDelete.push(a.id);
			}
		} catch {}
	}
	if (toDelete.length) {
		unlockAndDeleteArrows(editor, toDelete);
	}
}

type IframeShape = TLBaseShape<
	"iframe",
	{
		w: number;
		h: number;
		url: string;
	}
>;

class IframeShapeUtil extends BaseBoxShapeUtil<IframeShape> {
	static type = "iframe" as const;

	static props = {
		w: T.number,
		h: T.number,
		url: T.string,
	};

	getDefaultProps(): IframeShape["props"] {
		// Use relative URL in development (proxied by Vite), absolute URL in production
		return {
			w: IFRAME_W,
			h: IFRAME_H,
			url: `${baseUrl}/m?path=/wiki/Iannis_Xenakis`,
		};
	}

	component(shape: IframeShape) {
		const { w, h, url } = shape.props;
		const editor = useEditor();
		return (
			<HTMLContainer
				style={{
					width: w,
					height: h,
					overflow: "hidden",
					position: "relative",
					borderRadius: 10,
					border: "1px solid rgba(0,0,0,0.06)",
					boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.08)",
					background: "#fff",
				}}
			>
				<iframe
					name={shape.id}
					src={url}
					style={{
						position: "absolute",
						top: 32,
						left: 0,
						width: "100%",
						height: "calc(100% - 32px)",
						border: "none",
						pointerEvents: "auto",
						zIndex: 1,
					}}
					draggable={false}
					onPointerDown={(e) => e.stopPropagation()}
					onPointerMove={(e) => e.stopPropagation()}
					onPointerUp={(e) => e.stopPropagation()}
					sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
					ref={(el) => {
						try {
							if (el && el.contentWindow) {
								contentWindowToShapeId.set(el.contentWindow, shape.id);
							}
						} catch {}
					}}
				/>
				<div
					className="iframe-header"
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
						height: 32,
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "0 8px",
						gap: 8,
						background:
							"linear-gradient(to bottom, rgba(255,255,255,0.9), rgba(255,255,255,0.75))",
						borderBottom: "1px solid rgba(0,0,0,0.08)",
						backdropFilter: "blur(6px)",
						WebkitBackdropFilter: "blur(6px)",
						zIndex: 9999,
						cursor: "grab",
						pointerEvents: "auto",
					}}
					draggable={false}
					onDoubleClick={(e) => {
						e.stopPropagation();
						try {
							const s = editor.getShape?.(shape.id) as any;
							const b = {
								x: s?.x ?? 0,
								y: s?.y ?? 0,
								w: s?.props?.w ?? IFRAME_W,
								h: s?.props?.h ?? IFRAME_H,
							};
							const currentZoom = editor.getZoomLevel
								? editor.getZoomLevel()
								: 1;
							const targetZoom = Math.min(
								Math.max(currentZoom, 0.5) * 1.25,
								2.5
							);
							// @ts-ignore
							editor.zoomToBounds(b, {
								targetZoom,
								animation: { duration: 220 },
							});
						} catch {}
					}}
					onPointerEnter={(e) => {
						const el = e.currentTarget as HTMLElement;
						el.style.setProperty("cursor", "grab", "important");
						document.body.style.setProperty("cursor", "grab", "important");
						document.documentElement.style.setProperty(
							"cursor",
							"grab",
							"important"
						);
					}}
					onPointerMove={(e) => {
						const grabbing = (e.buttons & 1) === 1;
						const val = grabbing ? "grabbing" : "grab";
						const fallback = grabbing ? "move" : "move";
						const el = e.currentTarget as HTMLElement;
						el.style.setProperty("cursor", val, "important");
						document.body.style.setProperty("cursor", val, "important");
						document.documentElement.style.setProperty(
							"cursor",
							val,
							"important"
						);
						// in case grab is suppressed, set move as a second rule
						el.style.setProperty("cursor", fallback, "");
					}}
					onPointerDown={(e) => {
						const el = e.currentTarget as HTMLElement;
						el.style.setProperty("cursor", "grabbing", "important");
						document.body.style.setProperty("cursor", "grabbing", "important");
						document.documentElement.style.setProperty(
							"cursor",
							"grabbing",
							"important"
						);
					}}
					onPointerUp={() => {
						document.body.style.removeProperty("cursor");
						document.documentElement.style.removeProperty("cursor");
					}}
					onPointerLeave={(e) => {
						(e.currentTarget as HTMLElement).style.removeProperty("cursor");
						document.body.style.removeProperty("cursor");
						document.documentElement.style.removeProperty("cursor");
					}}
					onPointerCancel={(e) => {
						(e.currentTarget as HTMLElement).style.removeProperty("cursor");
						document.body.style.removeProperty("cursor");
						document.documentElement.style.removeProperty("cursor");
					}}
				>
					{/* left: grip / handle (drag area) */}
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 8,
							pointerEvents: "none",
						}}
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							aria-hidden="true"
							style={{ opacity: 0.55 }}
						>
							<circle cx="7" cy="7" r="1.5" fill="currentColor" />
							<circle cx="12" cy="7" r="1.5" fill="currentColor" />
							<circle cx="17" cy="7" r="1.5" fill="currentColor" />
							<circle cx="7" cy="12" r="1.5" fill="currentColor" />
							<circle cx="12" cy="12" r="1.5" fill="currentColor" />
							<circle cx="17" cy="12" r="1.5" fill="currentColor" />
						</svg>
					</div>
				</div>
			</HTMLContainer>
		);
	}

	indicator(shape: IframeShape) {
		return <rect width={shape.props.w} height={shape.props.h} />;
	}
}

// Canvas-resident Wikipedia search bar shape
type WikiSearchShape = TLBaseShape<
	"wikibar",
	{
		w: number;
		h: number;
	}
>;

class WikiSearchShapeUtil extends BaseBoxShapeUtil<WikiSearchShape> {
	static type = "wikibar" as const;

	static props = {
		w: T.number,
		h: T.number,
	};

	getDefaultProps(): WikiSearchShape["props"] {
		return { w: SEARCH_W, h: SEARCH_BAR_H };
	}

	component(shape: WikiSearchShape) {
		const editor = useEditor();
		const { w } = shape.props;

		const [query, setQuery] = useState("");
		const [results, setResults] = useState<
			Array<{ title: string; url: string }>
		>([]);
		const [isOpen, setIsOpen] = useState(false);
		const [isLoading, setIsLoading] = useState(false);
		const containerRef = useRef<HTMLDivElement>(null);
		const inputRef = useRef<HTMLInputElement>(null);

		// Auto-focus the input when the shape mounts
		useEffect(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		}, []);

		useEffect(() => {
			if (!query.trim()) {
				setResults([]);
				setIsOpen(false);
				return;
			}
			const timeoutId = setTimeout(async () => {
				setIsLoading(true);
				try {
					const response = await fetch(
						`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(
							query
						)}&limit=8&namespace=0&format=json&origin=*`
					);
					const data = await response.json();
					const titles = data[1] || [];
					const urls = data[3] || [];
					const searchResults = titles.map((title: string, i: number) => ({
						title,
						url:
							urls[i] ||
							`https://en.wikipedia.org/wiki/${encodeURIComponent(
								title.replace(/ /g, "_")
							)}`,
					}));
					setResults(searchResults);
					setIsOpen(searchResults.length > 0);
				} catch {
					setResults([]);
				} finally {
					setIsLoading(false);
				}
			}, 300);
			return () => clearTimeout(timeoutId);
		}, [query]);

		// Click-away removal
		useEffect(() => {
			const onDocMouseDown = (e: MouseEvent) => {
				const el = containerRef.current;
				if (!el) return;
				if (!el.contains(e.target as Node)) {
					try {
						editor.deleteShapes([shape.id] as any);
					} catch {}
				}
			};
			document.addEventListener("mousedown", onDocMouseDown, true);
			return () =>
				document.removeEventListener("mousedown", onDocMouseDown, true);
		}, [editor, shape.id]);

		const handleSelect = (url: string) => {
			const mobileUrl = url.replace("en.wikipedia.org", "en.m.wikipedia.org");
			const proxiedUrl = `${baseUrl}/m?url=${encodeURIComponent(mobileUrl)}`;

			let x = 0,
				y = 0;
			try {
				const s = editor.getShape(shape.id) as any;
				if (s) {
					x = s.x;
					y = s.y;
				}
			} catch {}

			const newFrameId = createShapeId();
			editor.createShape({
				id: newFrameId,
				type: "iframe",
				x,
				y,
				props: { url: proxiedUrl, w: IFRAME_W, h: IFRAME_H },
			});
			scheduleNormalizeZOrder(editor);
			const b = { x, y, w: IFRAME_W, h: IFRAME_H };
			focusBounds(editor, b, {
				minZoom: 1.2,
				bump: 1.3,
				maxZoom: 2.6,
				duration: 260,
			});
			editor.deleteShapes([shape.id] as any);
		};

		// Dynamic results height
		const resultsHeight =
			isOpen && results.length
				? Math.min(results.length * RESULT_ROW_H, RESULTS_MAX_H)
				: 0;

		// Ensure shape height follows content
		useEffect(() => {
			const targetH = SEARCH_BAR_H + resultsHeight;
			if (shape.props.h !== targetH) {
				editor.updateShape({
					id: shape.id,
					type: "wikibar",
					props: { h: targetH, w: shape.props.w },
				});
			}
		}, [resultsHeight]);

		return (
			<HTMLContainer
				style={{
					width: w,
					height: shape.props.h,
					overflow: "hidden",
					position: "relative",
					borderRadius: 10,
					border: "1px solid rgba(0,0,0,0.06)",
					boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.08)",
					background: "#fff",
					pointerEvents: "auto",
				}}
				onPointerDown={(e) => e.stopPropagation()}
				onPointerMove={(e) => e.stopPropagation()}
				onPointerUp={(e) => e.stopPropagation()}
			>
				<div
					ref={containerRef}
					style={{
						position: "absolute",
						inset: 0,
						display: "flex",
						flexDirection: "column",
						background: "#fefefe",
						borderRadius: 8,
						overflow: "hidden",
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							padding: "10px 14px",
							gap: 10,
							borderBottom: isOpen ? "1px solid rgba(0,0,0,0.08)" : "none",
							flexShrink: 0,
						}}
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="#66666d"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							style={{ flexShrink: 0 }}
						>
							<circle cx="11" cy="11" r="8" />
							<path d="m21 21-4.35-4.35" />
						</svg>
						<input
							ref={inputRef}
							type="text"
							placeholder="Search Wikipedia..."
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onFocus={() => {
								if (results.length > 0) setIsOpen(true);
							}}
							style={{
								flex: 1,
								border: "none",
								outline: "none",
								fontSize: 14,
								fontFamily:
									"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif",
								background: "transparent",
								color: "#1d1d1d",
							}}
						/>
						{isLoading && (
							<div
								style={{
									width: 14,
									height: 14,
									border: "2px solid rgba(0,0,0,0.08)",
									borderTopColor: "#66666d",
									borderRadius: "50%",
									animation: "spin 0.6s linear infinite",
									flexShrink: 0,
								}}
							/>
						)}
					</div>

					{isOpen && results.length > 0 && (
						<div
							style={{
								flex: 1,
								overflowY: "auto",
								background: "#fefefe",
							}}
						>
							{results.map((result, i) => (
								<button
									key={i}
									onClick={() => handleSelect(result.url)}
									style={{
										width: "100%",
										padding: "10px 14px",
										border: "none",
										background: "#fefefe",
										textAlign: "left",
										cursor: "pointer",
										fontSize: 13,
										fontFamily:
											"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif",
										color: "#1d1d1d",
										borderBottom:
											i < results.length - 1
												? "1px solid rgba(0,0,0,0.05)"
												: "none",
										transition: "background 0.12s ease",
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.background = "#f5f5f5";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.background = "#fefefe";
									}}
								>
									{result.title}
								</button>
							))}
						</div>
					)}
				</div>
				<style>
					{`
						@keyframes spin {
							from { transform: rotate(0deg); }
							to { transform: rotate(360deg); }
						}
					`}
				</style>
			</HTMLContainer>
		);
	}

	indicator(shape: WikiSearchShape) {
		return <rect width={shape.props.w} height={shape.props.h} />;
	}
}

// Add this new component before the App function
function WikipediaSearchBar({
	onSelectResult,
	baseUrl,
}: {
	onSelectResult: (url: string) => void;
	baseUrl: string;
}) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Array<{ title: string; url: string }>>(
		[]
	);
	const [isOpen, setIsOpen] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const searchRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
				setIsOpen(false);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	useEffect(() => {
		if (!query.trim()) {
			setResults([]);
			setIsOpen(false);
			return;
		}

		const timeoutId = setTimeout(async () => {
			setIsLoading(true);
			try {
				// Use Wikipedia's OpenSearch API
				const response = await fetch(
					`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(
						query
					)}&limit=8&namespace=0&format=json&origin=*`
				);
				const data = await response.json();

				// OpenSearch returns [query, [titles], [descriptions], [urls]]
				const titles = data[1] || [];
				const urls = data[3] || [];

				const searchResults = titles.map((title: string, i: number) => ({
					title,
					url:
						urls[i] ||
						`https://en.wikipedia.org/wiki/${encodeURIComponent(
							title.replace(/ /g, "_")
						)}`,
				}));

				setResults(searchResults);
				setIsOpen(searchResults.length > 0);
			} catch (error) {
				console.error("Search error:", error);
				setResults([]);
			} finally {
				setIsLoading(false);
			}
		}, 300); // Debounce for 300ms

		return () => clearTimeout(timeoutId);
	}, [query]);

	const handleSelect = (url: string) => {
		// Convert Wikipedia URL to mobile version
		const mobileUrl = url.replace("en.wikipedia.org", "en.m.wikipedia.org");
		const proxiedUrl = `${baseUrl}/m?url=${encodeURIComponent(mobileUrl)}`;
		onSelectResult(proxiedUrl);
		setQuery("");
		setResults([]);
		setIsOpen(false);
	};

	return (
		<div
			ref={searchRef}
			style={{
				position: "fixed",
				top: 16,
				left: "50%",
				transform: "translateX(-50%)",
				zIndex: 10000,
				width: "min(90%, 500px)",
			}}
		>
			<div
				style={{
					background: "#fefefe",
					borderRadius: 8,
					boxShadow: "0 0 0 1px rgba(0,0,0,0.1), 0 4px 12px rgba(0,0,0,0.12)",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						padding: "10px 14px",
						gap: 10,
						borderBottom: isOpen ? "1px solid rgba(0,0,0,0.08)" : "none",
					}}
				>
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="#66666d"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						style={{ flexShrink: 0 }}
					>
						<circle cx="11" cy="11" r="8" />
						<path d="m21 21-4.35-4.35" />
					</svg>
					<input
						type="text"
						placeholder="Search Wikipedia..."
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onFocus={() => {
							if (results.length > 0) setIsOpen(true);
						}}
						style={{
							flex: 1,
							border: "none",
							outline: "none",
							fontSize: 14,
							fontFamily:
								"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif",
							background: "transparent",
							color: "#1d1d1d",
						}}
					/>
					{isLoading && (
						<div
							style={{
								width: 14,
								height: 14,
								border: "2px solid rgba(0,0,0,0.08)",
								borderTopColor: "#66666d",
								borderRadius: "50%",
								animation: "spin 0.6s linear infinite",
								flexShrink: 0,
							}}
						/>
					)}
				</div>

				{isOpen && results.length > 0 && (
					<div
						style={{
							maxHeight: 360,
							overflowY: "auto",
							background: "#fefefe",
						}}
					>
						{results.map((result, i) => (
							<button
								key={i}
								onClick={() => handleSelect(result.url)}
								style={{
									width: "100%",
									padding: "10px 14px",
									border: "none",
									background: "#fefefe",
									textAlign: "left",
									cursor: "pointer",
									fontSize: 13,
									fontFamily:
										"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif",
									color: "#1d1d1d",
									borderBottom:
										i < results.length - 1
											? "1px solid rgba(0,0,0,0.05)"
											: "none",
									transition: "background 0.12s ease",
								}}
								onMouseEnter={(e) => {
									e.currentTarget.style.background = "#f5f5f5";
								}}
								onMouseLeave={(e) => {
									e.currentTarget.style.background = "#fefefe";
								}}
							>
								{result.title}
							</button>
						))}
					</div>
				)}
			</div>
			<style>
				{`
					@keyframes spin {
						from { transform: rotate(0deg); }
						to { transform: rotate(360deg); }
					}
				`}
			</style>
		</div>
	);
}

export default function App() {
	const editorRef = useRef<any>(null);

	// Add this function to find an empty space and create a new iframe
	const createIframeInEmptySpace = (url: string) => {
		const editor = editorRef.current;
		if (!editor) return;

		const GAP = 40;
		const all = editor
			.getCurrentPageShapes()
			.filter((sh: any) => sh.type === "iframe");

		// Helper to get bounds
		const getBounds = (shape: any) => ({
			x: shape.x,
			y: shape.y,
			w: shape.props?.w ?? IFRAME_W,
			h: shape.props?.h ?? IFRAME_H,
		});

		// Compute the rightmost edge among existing iframes
		let rightmostEdge = 200 + IFRAME_W; // default if none found
		if (all.length > 0) {
			rightmostEdge = Math.max(
				...all.map((sh: any) => {
					const b = getBounds(sh);
					return b.x + b.w;
				})
			);
		}

		// Start two columns to the right (leave one blank column for visual separation)
		let x = Math.max(200, rightmostEdge + IFRAME_W + 2 * GAP);
		const y = 200; // fixed row start for new search-created frames

		// Advance to the first empty column to the right if needed
		const columnHasBlockers = (testX: number) => {
			const colLeft = testX;
			const colRight = testX + IFRAME_W;
			return all
				.map((sh: any) => getBounds(sh))
				.some((b: any) => b.x < colRight && b.x + b.w > colLeft);
		};

		let guard = 0;
		while (columnHasBlockers(x) && guard < 50) {
			x += IFRAME_W + GAP;
			guard++;
		}

		// Create the new iframe
		const newFrameId = createShapeId();
		editor.createShape({
			id: newFrameId,
			type: "iframe",
			x,
			y,
			props: { url, w: IFRAME_W, h: IFRAME_H },
		});

		// Normalize z-order so iframes stay above arrows
		scheduleNormalizeZOrder(editor);

		// Zoom to the new frame
		const b = { x, y, w: IFRAME_W, h: IFRAME_H };
		const currentZoom = editor.getZoomLevel ? editor.getZoomLevel() : 1;
		const targetZoom = Math.min(Math.max(currentZoom, 0.5) * 1.12, 2);
		// @ts-ignore
		editor.zoomToBounds(b, { targetZoom, animation: { duration: 240 } });
	};

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			const data = e.data;
			if (!data || typeof data !== "object") return;

			// Handle zoom forwarded from inside an iframe (pinch / ctrl+wheel)
			if ((data as any).type === "iframe-zoom") {
				const editor = editorRef.current;
				if (!editor) return;

				const sourceId = (data as any).sourceId as string | undefined;
				if (!sourceId) return;

				const iframeEl = document.querySelector(
					`iframe[name="${sourceId}"]`
				) as HTMLIFrameElement | null;
				if (!iframeEl) return;
				const r = iframeEl.getBoundingClientRect();

				const localX = Number((data as any).clientX) || r.width / 2;
				const localY = Number((data as any).clientY) || r.height / 2;
				const clientX = r.left + localX;
				const clientY = r.top + localY;

				const container = document.querySelector(
					".tl-container"
				) as HTMLElement | null;
				if (!container) return;

				const ev = new WheelEvent("wheel", {
					deltaY: Number((data as any).deltaY) || 0,
					ctrlKey: true,
					clientX,
					clientY,
					bubbles: true,
					cancelable: true,
					deltaMode: 0,
				});
				container.dispatchEvent(ev);
				return;
			}

			// Zoom to the iframe bounds on double-click inside the iframe
			if ((data as any).type === "iframe-dblclick") {
				const editor = editorRef.current;
				if (!editor) return;

				const sourceId = (data as any).sourceId as string | undefined;
				if (!sourceId) return;

				try {
					const s = editor.getShape?.(sourceId) as any;
					if (!s || s.type !== "iframe") return;
					const b = {
						x: s.x,
						y: s.y,
						w: s.props?.w ?? IFRAME_W,
						h: s.props?.h ?? IFRAME_H,
					};
					const currentZoom = editor.getZoomLevel ? editor.getZoomLevel() : 1;
					const targetZoom = Math.min(Math.max(currentZoom, 0.5) * 1.25, 2.5);
					// @ts-ignore
					editor.zoomToBounds(b, { targetZoom, animation: { duration: 220 } });
				} catch {}
				return;
			}

			if (
				(data as any).type !== "wiki-link" ||
				typeof (data as any).href !== "string"
			)
				return;

			const href = (data as any).href as string;

			// normalize to absolute wikipedia mobile URL if needed
			const normalizedHref = href.startsWith("http")
				? href
				: `https://en.m.wikipedia.org${href.startsWith("/") ? "" : "/"}${href}`;

			// Check if URL is already proxied (either relative /m or absolute including baseUrl)
			const isAlreadyProxied =
				normalizedHref.startsWith("/m") ||
				normalizedHref.includes("/m?url=") ||
				normalizedHref.includes("/m?path=");

			const proxied = isAlreadyProxied
				? normalizedHref
				: `${baseUrl}/m?url=${encodeURIComponent(normalizedHref)}`;

			const fromWin = e.source as Window | null;
			const hintedId = (data as any).sourceId as string | undefined;
			const fromShapeId =
				hintedId ||
				(fromWin ? contentWindowToShapeId.get(fromWin as Window) : undefined);
			const editor = editorRef.current;
			if (!editor) return;

			// Dedup key: source shape id + normalized URL
			const sourceIdForKey = fromShapeId ?? "unknown";
			const dedupKey = `${sourceIdForKey}::${proxied}`;
			const now = Date.now();
			const last = recentlyHandled.get(dedupKey) ?? 0;
			if (now - last < 250) return;
			recentlyHandled.set(dedupKey, now);

			// Common gap between shapes
			const GAP = 40;

			let x = 200;
			let y = 200;

			// Helper to get bounds for any iframe shape using stored props
			const getBounds = (shape: any) => ({
				x: shape.x,
				y: shape.y,
				w: shape.props?.w ?? IFRAME_W,
				h: shape.props?.h ?? IFRAME_H,
			});
			if (fromShapeId) {
				const s = editor.getShape(fromShapeId);
				if (s && s.type === "iframe") {
					// Place to the immediate right of the source iframe using its actual bounds
					const sb = getBounds(s);
					x = sb.x + sb.w + GAP;
					y = sb.y;
				}
			}

			// Column placement: only consider iframes that overlap this column horizontally
			const all = editor
				.getCurrentPageShapes()
				.filter((sh: any) => sh.type === "iframe");
			const others = fromShapeId
				? all.filter((sh: any) => sh.id !== fromShapeId)
				: all;
			const colLeft = x;
			const colRight = x + IFRAME_W;
			const blockers = others
				.map((sh: any) => getBounds(sh))
				.filter(
					(b: { x: number; y: number; w: number; h: number }) =>
						b.x < colRight && b.x + b.w > colLeft
				)
				.sort((a: any, b: any) => a.y - b.y);

			let yPos = y;
			for (const b of blockers) {
				const overlapsVertically = yPos < b.y + b.h && yPos + IFRAME_H > b.y;
				if (overlapsVertically) yPos = b.y + b.h + GAP;
			}

			// Create the new frame with a known id so we can bind an arrow to it
			const newFrameId = createShapeId();
			editor.createShape({
				id: newFrameId,
				type: "iframe",
				x,
				y: yPos,
				props: { url: proxied, w: IFRAME_W, h: IFRAME_H },
			});

			// Create a connected arrow from the source frame to the new frame
			if (fromShapeId) {
				const arrowId = createShapeId();
				editor.createShape({
					id: arrowId,
					type: "arrow",
					isLocked: true,
					x: 0,
					y: 0,
					props: {
						start: { x: 0, y: 0 },
						end: { x: 100, y: 0 },
						bend: 0,
					},
				});

				// Send this arrow behind shapes and normalize globally
				editor.sendToBack([arrowId]);
				scheduleNormalizeZOrder(editor);
				editor.createBinding({
					type: "arrow",
					fromId: arrowId,
					toId: fromShapeId,
					props: { terminal: "start", normalizedAnchor: { x: 0.98, y: 0.5 } },
				});
				editor.createBinding({
					type: "arrow",
					fromId: arrowId,
					toId: newFrameId,
					props: { terminal: "end", normalizedAnchor: { x: 0.02, y: 0.5 } },
				});
				// Track relationships for multi-delete
				arrowIdToFrameIds.set(arrowId, { from: fromShapeId, to: newFrameId });
				linkArrowToFrame(fromShapeId, arrowId);
				linkArrowToFrame(newFrameId, arrowId);
			}

			// Center + slight zoom onto the new frame
			const b = { x, y: yPos, w: IFRAME_W, h: IFRAME_H };
			const currentZoom = editor.getZoomLevel ? editor.getZoomLevel() : 1;
			const targetZoom = Math.min(Math.max(currentZoom, 0.5) * 1.12, 2);
			// @ts-ignore - allow plain bounds object
			editor.zoomToBounds(b, { targetZoom, animation: { duration: 240 } });
		};
		window.addEventListener("message", handler);
		return () => window.removeEventListener("message", handler);
	}, []);

	// Background safety net: periodically sweep for orphan arrows
	useEffect(() => {
		const id = window.setInterval(() => {
			const editor = editorRef.current;
			if (editor) sweepOrphanArrows(editor);
		}, 400);
		return () => window.clearInterval(id);
	}, []);

	return (
		<div style={{ position: "fixed", inset: 0 }}>
			<Tldraw
				licenseKey="tldraw-2026-01-06/WyJDQWNfSnlQRSIsWyIqIl0sMTYsIjIwMjYtMDEtMDYiXQ.jffxTKOc24XLz+ij+h5MATFy3tQb0YwQiZGh8Kjino9R1d6pkah7Wm/7Fudq4ac0ruj81ofGDy75u9gCl8OPCg"
				persistenceKey="example"
				shapeUtils={[IframeShapeUtil, WikiSearchShapeUtil]}
				onMount={(editor) => {
					editorRef.current = editor;
					const shapes = editor
						.getCurrentPageShapes()
						.filter((s) => s.type === "iframe");
					for (const s of shapes) {
						// @ts-ignore
						const u = s.props?.url as string | undefined;
						if (u && /^https?:\/\//.test(u)) {
							editor.updateShape({
								id: s.id,
								type: "iframe",
								props: {
									url: `${baseUrl}/m?url=${encodeURIComponent(u)}`,
									w: IFRAME_W,
									h: IFRAME_H,
								},
							});
						} else {
							// Normalize dimensions for any existing iframes
							editor.updateShape({
								id: s.id,
								type: "iframe",
								props: { w: IFRAME_W, h: IFRAME_H },
							});
						}
					}
					// When an iframe is deleted, also delete any arrows that were bound to it
					// We detect deletions via the store history diff and look for removed
					// arrow bindings whose toId was one of the removed iframe ids.
					editor.store.listen((entry: any) => {
						const removed = Object.values(
							entry?.changes?.removed ?? {}
						) as any[];
						// Always schedule a sweep after this transaction settles
						scheduleSweep(editor);
						// Also normalize z-order after transactions settle
						scheduleNormalizeZOrder(editor);
						if (removed.length === 0) return;

						const removedIframeIds = new Set<string>();
						for (const rec of removed) {
							if (rec?.typeName === "shape" && rec?.type === "iframe") {
								removedIframeIds.add(rec.id as string);
							}
						}
						if (removedIframeIds.size === 0) return;

						const arrowsToDelete = new Set<string>();
						for (const rec of removed) {
							// If an arrow binding points to a removed frame, delete the arrow
							if (rec?.typeName === "binding" && rec?.type === "arrow") {
								const toId = rec.toId as string;
								const fromId = rec.fromId as string;
								if (removedIframeIds.has(toId)) {
									arrowsToDelete.add(fromId);
								}
								// Also consult our relationship index to cover cases when bindings were removed first
								const related = arrowIdToFrameIds.get(fromId);
								if (
									related &&
									(removedIframeIds.has(related.from ?? "") ||
										removedIframeIds.has(related.to ?? ""))
								) {
									arrowsToDelete.add(fromId);
								}
							}

							// If an arrow shape itself is removed, keep our local index tidy
							if (rec?.typeName === "shape" && rec?.type === "arrow") {
								unlinkArrowFromFrames(rec.id as string);
							}
						}

						// Also remove any arrows that our index says are connected to the removed frames
						for (const frameId of removedIframeIds) {
							const set = frameIdToArrowIds.get(frameId);
							if (set) {
								for (const arrowId of set) arrowsToDelete.add(arrowId);
							}
						}

						// HARD CHECK: scan all current arrows; if any binding references a removed iframe id,
						// or the arrow has fewer than two bindings, mark it for deletion
						try {
							const arrowsNowHard = editor
								.getCurrentPageShapes()
								.filter((s: any) => s.type === "arrow");
							for (const a of arrowsNowHard) {
								const bindings = editor.getBindingsFromShape(
									a.id,
									"arrow"
								) as any[];
								if (!bindings || bindings.length < 2) {
									arrowsToDelete.add(a.id);
									continue;
								}
								for (const b of bindings) {
									const toId = (b as any).toId as string | undefined;
									if (toId && removedIframeIds.has(toId)) {
										arrowsToDelete.add(a.id);
									}
								}
							}
						} catch {}

						// Defer final deletion until after bindings settle for this transaction (no visual frame)
						queueMicrotask(() => {
							unlockAndDeleteArrows(editor, arrowsToDelete);
							queueMicrotask(() => sweepOrphanArrows(editor));
						});
					});

					// Also lock any existing arrows and send them behind frames
					const existingArrows = editor
						.getCurrentPageShapes()
						.filter((s: any) => s.type === "arrow");
					if (existingArrows.length > 0) {
						// lock
						editor.updateShapes(
							existingArrows.map((s: any) => ({
								id: s.id,
								type: "arrow",
								isLocked: true,
							}))
						);

						// Normalize global z-order for arrows/iframes
						scheduleNormalizeZOrder(editor);

						// Build the frame↔arrow index from existing arrow bindings
						for (const a of existingArrows) {
							try {
								const bindings = editor.getBindingsFromShape(
									a.id,
									"arrow"
								) as any[];
								const start = bindings.find(
									(b: any) => b.props?.terminal === "start"
								);
								const end = bindings.find(
									(b: any) => b.props?.terminal === "end"
								);
								const fromId = start?.toId as string | undefined;
								const toId = end?.toId as string | undefined;
								if (fromId || toId) {
									arrowIdToFrameIds.set(a.id, { from: fromId, to: toId });
									if (fromId) linkArrowToFrame(fromId, a.id);
									if (toId) linkArrowToFrame(toId, a.id);
								}
							} catch {}
						}
					}

					// One-time sweep on mount to normalize any dangling arrows in existing docs
					sweepOrphanArrows(editor);

					// Handle double-click to create a temporary Wikipedia search bar at the clicked page point
					const container = document.querySelector(
						".tl-container"
					) as HTMLElement | null;
					// Detect double click via pointerdown (so we beat TLDraw's dblclick/text flow)
					let lastDownTime = 0;
					let lastDownX = 0;
					let lastDownY = 0;
					const DOUBLE_MS = 350;
					const DOUBLE_DIST = 8;

					const onPointerDownDoc = (ev: PointerEvent) => {
						try {
							if (!container || !container.contains(ev.target as Node)) return;

							const t = (ev.timeStamp as number) || Date.now();
							const x = ev.clientX;
							const y = ev.clientY;
							const dt = t - lastDownTime;
							const dist = Math.hypot(x - lastDownX, y - lastDownY);
							const isDouble = dt < DOUBLE_MS && dist < DOUBLE_DIST;

							lastDownTime = t;
							lastDownX = x;
							lastDownY = y;

							if (!isDouble) return;

							// Intercept before TLDraw; prevent its default text creation
							ev.preventDefault();
							ev.stopPropagation();
							// @ts-ignore
							typeof (ev as any).stopImmediatePropagation === "function" &&
								(ev as any).stopImmediatePropagation();
							(editor as any).setCurrentTool?.("select");

							const rect = container.getBoundingClientRect();
							let pageX = 200,
								pageY = 200;

							if ((editor as any).screenToPage && rect) {
								const p = (editor as any).screenToPage({ x, y });
								pageX = p.x;
								pageY = p.y;
							} else if (rect) {
								const cam = (editor as any).getCamera
									? (editor as any).getCamera()
									: { x: 0, y: 0, z: (editor as any).getZoomLevel?.() ?? 1 };
								const z =
									cam && typeof cam.z === "number"
										? cam.z
										: (editor as any).getZoomLevel?.() ?? 1;
								pageX = (x - rect.left) / z + (cam?.x ?? 0);
								pageY = (y - rect.top) / z + (cam?.y ?? 0);
							}

							const id = createShapeId();
							editor.createShape({
								id,
								type: "wikibar",
								x: pageX,
								y: pageY,
								props: { w: SEARCH_W, h: SEARCH_BAR_H },
							});

							editor.bringToFront([id]);
							scheduleNormalizeZOrder(editor);

							const b = { x: pageX, y: pageY, w: SEARCH_W, h: SEARCH_BAR_H };
							focusBounds(editor, b, {
								minZoom: 1.2,
								bump: 1.35,
								maxZoom: 2.6,
								duration: 260,
							});
						} catch {}
					};

					// Listen on document capture so we beat TLDraw's internal handlers
					document.addEventListener("pointerdown", onPointerDownDoc, {
						capture: true,
					});
					// Clean up listener when the React component unmounts
					return () => {
						document.removeEventListener("pointerdown", onPointerDownDoc, {
							capture: true,
						} as any);
					};
				}}
			/>
		</div>
	);
}
