/// <reference types="vite/client" />

// the rules / EV / netcode UMD files are imported only for their side-effects (window.* globals)
declare module '*.js';
