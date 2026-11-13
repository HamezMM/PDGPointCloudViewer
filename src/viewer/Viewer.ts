import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

/** Content that can be picked and that defines the scene bounds (scan, model). */
export const LAYER_CONTENT = 0;
/** Helpers: bounding boxes, section box gizmo, measurement lines. Not pickable. */
export const LAYER_HELPERS = 1;

/**
 * Owns the renderer, camera, controls and an on-demand render loop. With 10M+ points we only
 * redraw when something changes, so the GPU is idle while you read the screen.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly labelRenderer: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Pickable content root. */
  readonly content = new THREE.Group();
  /** Non-pickable helpers root. Lives in its own scene so it is never clipped by the section box. */
  readonly helpers = new THREE.Group();
  readonly helperScene = new THREE.Scene();
  /** Section box planes; applied to the content pass only. */
  clipPlanes: THREE.Plane[] = [];
  /** Called every frame before render (e.g. to update point size uniforms). */
  readonly beforeRender: Array<() => void> = [];

  private needsRender = true;
  private sceneRadius = 10;

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x1b1d21, 1);
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(container.clientWidth, container.clientHeight);
    Object.assign(this.labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 1000);
    this.camera.position.set(8, 6, 8);
    this.camera.layers.enable(LAYER_HELPERS);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(this.content);
    this.helperScene.add(this.helpers);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 2.0));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(1, 2, 1.5);
    this.scene.add(dir);

    const grid = new THREE.GridHelper(20, 20, 0x444a55, 0x30343b);
    grid.name = 'grid';
    grid.layers.set(LAYER_HELPERS);
    this.helpers.add(grid);

    new ResizeObserver(() => this.resize()).observe(container);
    this.loop();
  }

  requestRender() {
    this.needsRender = true;
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.requestRender();
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    // damping keeps emitting 'change' while settling
    this.controls.update();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.updateClipRange();
    for (const fn of this.beforeRender) fn();
    this.renderer.autoClear = true;
    this.renderer.clippingPlanes = this.clipPlanes;
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = false;
    this.renderer.clippingPlanes = [];
    this.renderer.render(this.helperScene, this.camera);
    this.renderer.autoClear = true;
    this.labelRenderer.render(this.helperScene, this.camera);
  };

  /** Keep near/far tight around the content for depth precision (important for picking). */
  private updateClipRange() {
    const d = this.camera.position.distanceTo(this.controls.target);
    const far = Math.max(d + this.sceneRadius * 4, 10);
    const near = Math.max(Math.min(d / 500, this.sceneRadius / 2000), 0.001);
    if (Math.abs(this.camera.far - far) > 1e-6 || Math.abs(this.camera.near - near) > 1e-9) {
      this.camera.far = far;
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /** World-space bounds of all visible pickable content. */
  contentBox(): THREE.Box3 {
    const box = new THREE.Box3();
    this.content.updateMatrixWorld(true);
    this.content.traverseVisible((o) => {
      const fn = (o as any).getWorldBox as (() => THREE.Box3 | null) | undefined;
      if (fn) {
        const b = fn.call(o);
        if (b && !b.isEmpty()) box.union(b);
      }
    });
    return box;
  }

  setSceneRadius(r: number) {
    this.sceneRadius = Math.max(r, 0.5);
    const grid = this.helpers.getObjectByName('grid') as THREE.GridHelper | undefined;
    if (grid) {
      // Re-size the grid to roughly the content size, 1 m cells up to 200 m, then coarser.
      const size = Math.max(10, Math.ceil((this.sceneRadius * 2.5) / 10) * 10);
      const divisions = size <= 200 ? size : Math.ceil(size / 10);
      this.helpers.remove(grid);
      grid.geometry.dispose();
      const g = new THREE.GridHelper(size, divisions, 0x444a55, 0x30343b);
      g.name = 'grid';
      g.layers.set(LAYER_HELPERS);
      g.visible = grid.visible;
      g.position.copy(grid.position);
      this.helpers.add(g);
    }
  }

  setGridY(y: number) {
    const grid = this.helpers.getObjectByName('grid');
    if (grid) grid.position.y = y;
  }

  fitTo(box: THREE.Box3, keepDirection = true) {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
    const dir = keepDirection
      ? this.camera.position.clone().sub(this.controls.target).normalize()
      : new THREE.Vector3(1, 0.8, 1).normalize();
    if (dir.lengthSq() === 0) dir.set(1, 0.8, 1).normalize();
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }
}
