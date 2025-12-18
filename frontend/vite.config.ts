/// <reference types="vite/client" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			"/m": {
				target: "https://server-flax-ten-71.vercel.app",
				changeOrigin: true,
			},
			"/i": {
				target: "https://server-flax-ten-71.vercel.app",
				changeOrigin: true,
			},
			"/static": {
				target: "https://server-flax-ten-71.vercel.app",
				changeOrigin: true,
			},
			"/w": {
				target: "https://server-flax-ten-71.vercel.app",
				changeOrigin: true,
			},
		},
	},
	build: {
		// Ensure proper base URL for production builds
		outDir: "dist",
		assetsDir: "assets",
	},
});
