// App entry. The rules / EV / netcode live in dependency-free UMD modules under public/ and are
// loaded as classic <script> tags in index.html (they install window.General, window.MP, … before
// this deferred module runs) — that keeps them out of the bundle and lets the Node test-suite keep
// require()-ing the same files. Here we only pull in the styles and the UI.
import './styles.css';
import './app.js';
