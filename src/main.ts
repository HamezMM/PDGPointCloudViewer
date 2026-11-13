import './style.css';
import { App } from './app';
import { buildPanel } from './ui/Panel';

const app = new App(document.getElementById('app')!);

const xyzInput = document.getElementById('file-xyz') as HTMLInputElement;
const jsonInput = document.getElementById('file-json') as HTMLInputElement;
xyzInput.addEventListener('change', () => { if (xyzInput.files?.[0]) app.loadScan(xyzInput.files[0]); xyzInput.value = ''; });
jsonInput.addEventListener('change', () => { if (jsonInput.files?.[0]) app.loadModel(jsonInput.files[0]); jsonInput.value = ''; });

buildPanel(app, () => xyzInput.click(), () => jsonInput.click());

function openFile(file: File) {
  if (/\.json$/i.test(file.name)) app.loadModel(file);
  else app.loadScan(file);
}

// Drag and drop anywhere
const overlay = document.getElementById('drop-overlay')!;
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; overlay.classList.add('active'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove('active'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.remove('active');
  for (const f of Array.from(e.dataTransfer?.files ?? [])) openFile(f);
});

// Exposed for debugging and end-to-end tests.
(window as any).app = app;
