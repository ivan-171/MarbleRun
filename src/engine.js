import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { rngFromSeed } from './logic.js';

const WIDTH = 10.5;
const START_Y = 3.2;
const SLOPE = 0.105;
const FLOOR_THICKNESS = 0.28;
const WALL_H = 1.05;
const RADIUS = 0.43;
const FIXED_DT = 1 / 60;

const COLORS = {
  floor: 0xe8edf3,
  wall: 0xd6dde7,
  dark: 0x2d3440,
  accent: 0xff5a6f,
  accent2: 0x5b8cff,
  yellow: 0xffc857,
  mint: 0x44d7b6,
  purple: 0x9b6dff,
};

function hexToNumber(hex) {
  return Number.parseInt(hex.replace('#', ''), 16);
}

function lerp(a, b, t) { return a + (b - a) * t; }

export class MarbleEngine {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xbdd7f4);
    this.scene.fog = new THREE.Fog(0xbdd7f4, 60, 240);

    this.camera = new THREE.PerspectiveCamera(54, 1, 0.1, 600);
    this.camera.position.set(0, 12, 18);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'game-canvas';
    this.container.appendChild(this.renderer.domElement);

    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    this.world.allowSleep = true;
    this.world.solver.iterations = 8;
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);

    this.marbleMaterial = new CANNON.Material('marble');
    this.trackMaterial = new CANNON.Material('track');
    this.obstacleMaterial = new CANNON.Material('obstacle');
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.marbleMaterial, this.trackMaterial, {
      friction: 0.14, restitution: 0.12,
    }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.marbleMaterial, this.obstacleMaterial, {
      friction: 0.08, restitution: 0.36,
    }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.marbleMaterial, this.marbleMaterial, {
      friction: 0.03, restitution: 0.28,
    }));

    this.trackGroup = new THREE.Group();
    this.marbleGroup = new THREE.Group();
    this.scene.add(this.trackGroup, this.marbleGroup);

    this.floorMat = new THREE.MeshStandardMaterial({ color: COLORS.floor, roughness: 0.78, metalness: 0.03 });
    this.wallMat = new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.7, metalness: 0.02 });
    this.darkMat = new THREE.MeshStandardMaterial({ color: COLORS.dark, roughness: 0.48, metalness: 0.12 });

    this.kinematics = [];
    this.trackBodies = [];
    this.marbleBodies = [];
    this.marbles = [];
    this.running = false;
    this.simTime = 0;
    this.speed = 1;
    this.cameraMode = 'auto';
    this.followId = null;
    this.lastHud = 0;
    this.lastAutoCamera = 0;
    this.autoTargetId = null;
    this.finishZ = -120;
    this.trackPlan = null;
    this.finishResults = [];
    this.currentParticipants = [];
    this.raceRng = rngFromSeed('marbleforge');
    this.raf = null;

    this.setupLights();
    this.setupBackdrop();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.animate = this.animate.bind(this);
    this.raf = requestAnimationFrame(this.animate);
  }

  setupLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x71839b, 2.15);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 3.1);
    key.position.set(-20, 35, 20);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -28;
    key.shadow.camera.right = 28;
    key.shadow.camera.top = 35;
    key.shadow.camera.bottom = -35;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 130;
    this.scene.add(key);
  }

  setupBackdrop() {
    const grid = new THREE.GridHelper(500, 80, 0xffffff, 0xffffff);
    grid.material.opacity = 0.12;
    grid.material.transparent = true;
    grid.position.y = -30;
    this.scene.add(grid);

    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(8, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xffe3a6 })
    );
    sun.position.set(-55, 48, -160);
    this.scene.add(sun);
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  trackY(z) { return START_Y + SLOPE * z; }

  clearWorldObjects() {
    this.running = false;
    for (const body of [...this.trackBodies, ...this.marbleBodies]) this.world.removeBody(body);
    this.trackBodies.length = 0;
    this.marbleBodies.length = 0;
    this.kinematics.length = 0;
    this.marbles.length = 0;
    this.finishResults.length = 0;
    this.trackGroup.clear();
    this.marbleGroup.clear();
  }

  buildTrack(plan) {
    this.clearWorldObjects();
    this.trackPlan = plan;
    this.finishZ = -(plan.totalLength - 1.4);
    this.raceRng = rngFromSeed(`physics:${plan.seed}:${plan.format}`);

    this.addRampSegment(5, 0, 'start');
    let cursor = 0;
    for (const module of plan.modules) {
      const startZ = -cursor;
      const endZ = -(cursor + module.length);
      this.addRampSegment(startZ, endZ, module.type, module.index);
      this.decorateModule(module, startZ, endZ);
      cursor += module.length;
    }
    this.addFinishGate(this.finishZ);
    this.camera.position.set(0, 11, 17);
    this.camera.lookAt(0, this.trackY(-8), -9);
  }

  addRampSegment(startZ, endZ, type = 'straight', index = 0) {
    const length = Math.abs(endZ - startZ);
    const centerZ = (startZ + endZ) / 2;
    const centerY = this.trackY(centerZ);
    const angle = -Math.atan(SLOPE);
    const colorShift = index % 2 === 0 ? COLORS.floor : 0xf2f5f8;
    const mat = new THREE.MeshStandardMaterial({ color: colorShift, roughness: 0.76, metalness: 0.02 });

    const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(WIDTH, FLOOR_THICKNESS, length + 0.12), mat);
    floorMesh.position.set(0, centerY - FLOOR_THICKNESS / 2, centerZ);
    floorMesh.rotation.x = angle;
    floorMesh.receiveShadow = true;
    this.trackGroup.add(floorMesh);

    const floorBody = new CANNON.Body({ mass: 0, material: this.trackMaterial });
    floorBody.addShape(new CANNON.Box(new CANNON.Vec3(WIDTH / 2, FLOOR_THICKNESS / 2, length / 2 + 0.06)));
    floorBody.position.set(0, centerY - FLOOR_THICKNESS / 2, centerZ);
    floorBody.quaternion.setFromEuler(angle, 0, 0);
    this.world.addBody(floorBody);
    this.trackBodies.push(floorBody);

    for (const side of [-1, 1]) {
      const wallMesh = new THREE.Mesh(new THREE.BoxGeometry(0.28, WALL_H, length + 0.1), this.wallMat);
      wallMesh.position.set(side * (WIDTH / 2 + 0.02), centerY + WALL_H / 2 - 0.05, centerZ);
      wallMesh.rotation.x = angle;
      wallMesh.castShadow = true;
      wallMesh.receiveShadow = true;
      this.trackGroup.add(wallMesh);

      const body = new CANNON.Body({ mass: 0, material: this.trackMaterial });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.14, WALL_H / 2, length / 2)));
      body.position.set(side * (WIDTH / 2 + 0.02), centerY + WALL_H / 2 - 0.05, centerZ);
      body.quaternion.setFromEuler(angle, 0, 0);
      this.world.addBody(body);
      this.trackBodies.push(body);
    }

    if (type !== 'start') {
      const support = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.24, 4.2, 8),
        new THREE.MeshStandardMaterial({ color: 0xaab4c3, roughness: 0.85 })
      );
      support.position.set(index % 2 ? 3.8 : -3.8, centerY - 2.25, centerZ);
      support.castShadow = true;
      this.trackGroup.add(support);
    }
  }

  addStaticBox({ x = 0, z, w = 1, h = 1, d = 1, color = COLORS.dark, rotY = 0, y = null, bounce = true }) {
    const yy = y ?? (this.trackY(z) + h / 2 + 0.05);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.48, metalness: 0.08 })
    );
    mesh.position.set(x, yy, z);
    mesh.rotation.y = rotY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.trackGroup.add(mesh);

    const body = new CANNON.Body({ mass: 0, material: bounce ? this.obstacleMaterial : this.trackMaterial });
    body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
    body.position.set(x, yy, z);
    body.quaternion.setFromEuler(0, rotY, 0);
    this.world.addBody(body);
    this.trackBodies.push(body);
    return { mesh, body };
  }

  addPin(x, z, radius = 0.36, color = COLORS.accent2) {
    const h = 1.2;
    const y = this.trackY(z) + h / 2 + 0.05;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, h, 12),
      new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.12 })
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    this.trackGroup.add(mesh);
    const body = new CANNON.Body({ mass: 0, material: this.obstacleMaterial });
    body.addShape(new CANNON.Cylinder(radius, radius, h, 12));
    body.position.set(x, y, z);
    this.world.addBody(body);
    this.trackBodies.push(body);
  }

  addBumpBar(z, radius = 0.18, color = COLORS.yellow, offset = 0) {
    // A speed bump must create chaos, never a wall. Keep it low and leave
    // generous escape lanes on both sides (well over one marble diameter).
    const safeRadius = Math.min(radius, 0.20);
    const barLen = WIDTH - 3.25;
    const safeOffset = Math.max(-0.32, Math.min(0.32, offset));
    const y = this.trackY(z) + safeRadius + 0.045;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(safeRadius, safeRadius, barLen, 12),
      new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.05 })
    );
    mesh.position.set(safeOffset, y, z);
    mesh.rotation.z = Math.PI / 2;
    mesh.castShadow = true;
    this.trackGroup.add(mesh);
    const body = new CANNON.Body({ mass: 0, material: this.obstacleMaterial });
    const shape = new CANNON.Cylinder(safeRadius, safeRadius, barLen, 12);
    const q = new CANNON.Quaternion();
    q.setFromEuler(0, 0, Math.PI / 2);
    body.addShape(shape, new CANNON.Vec3(), q);
    body.position.set(safeOffset, y, z);
    this.world.addBody(body);
    this.trackBodies.push(body);
  }

  addSpinner(z, direction = 1, scale = 1, phase = 0) {
    const y = this.trackY(z) + 0.64;
    const barLen = 6.2 * scale;
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: COLORS.purple, roughness: 0.34, metalness: 0.12 });
    for (const ry of [0, Math.PI / 2]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(barLen, 0.26, 0.34), mat);
      bar.rotation.y = ry;
      bar.castShadow = true;
      group.add(bar);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.5, 16), this.darkMat);
    hub.castShadow = true;
    group.add(hub);
    group.position.set(0, y, z);
    this.trackGroup.add(group);

    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: this.obstacleMaterial });
    const box = new CANNON.Box(new CANNON.Vec3(barLen / 2, 0.13, 0.17));
    body.addShape(box);
    const q2 = new CANNON.Quaternion();
    q2.setFromEuler(0, Math.PI / 2, 0);
    body.addShape(box, new CANNON.Vec3(), q2);
    body.position.set(0, y, z);
    this.world.addBody(body);
    this.trackBodies.push(body);
    this.kinematics.push({
      body, mesh: group,
      update: (t) => {
        const angle = phase + t * direction * (1.1 + 0.45 * scale);
        body.quaternion.setFromEuler(0, angle, 0);
        body.angularVelocity.set(0, direction * (1.1 + 0.45 * scale), 0);
        group.rotation.y = angle;
        body.aabbNeedsUpdate = true;
      }
    });
  }

  addMovingGate(z, phase = 0, speed = 1.2, width = 2.4, amp = 3.2, color = COLORS.accent) {
    const h = 0.9;
    const y = this.trackY(z) + h / 2 + 0.12;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, h, 0.38),
      new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.08 })
    );
    mesh.castShadow = true;
    this.trackGroup.add(mesh);
    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: this.obstacleMaterial });
    body.addShape(new CANNON.Box(new CANNON.Vec3(width / 2, h / 2, 0.19)));
    body.position.set(0, y, z);
    this.world.addBody(body);
    this.trackBodies.push(body);
    this.kinematics.push({
      body, mesh,
      update: (t) => {
        const x = Math.sin(t * speed + phase) * amp;
        body.position.set(x, y, z);
        body.velocity.set(Math.cos(t * speed + phase) * amp * speed, 0, 0);
        mesh.position.set(x, y, z);
        body.aabbNeedsUpdate = true;
      }
    });
  }

  addSidePuncher(z, side = -1, phase = 0, speed = 1.7) {
    const w = 2.2, h = 0.85, d = 0.7;
    const y = this.trackY(z) + h / 2 + 0.1;
    const base = side * 4.7;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color: COLORS.mint, roughness: 0.35, metalness: 0.06 })
    );
    mesh.castShadow = true;
    this.trackGroup.add(mesh);
    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: this.obstacleMaterial });
    body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
    this.world.addBody(body);
    this.trackBodies.push(body);
    this.kinematics.push({
      body, mesh,
      update: (t) => {
        const travel = (Math.sin(t * speed + phase) + 1) * 0.5 * 2.1;
        const x = base - side * travel;
        body.position.set(x, y, z);
        body.velocity.set(-side * Math.cos(t * speed + phase) * 2.1 * speed * 0.5, 0, 0);
        mesh.position.set(x, y, z);
        body.aabbNeedsUpdate = true;
      }
    });
  }

  decorateModule(module, startZ, endZ) {
    const center = (startZ + endZ) / 2;
    const span = Math.abs(endZ - startZ);
    const v = module.variant;
    const sign = module.spin;
    const jitter = (n = 1) => (((v * 9301 + n * 49297) % 233280) / 233280 - 0.5) * 2;
    const colorA = [COLORS.accent, COLORS.accent2, COLORS.yellow, COLORS.mint, COLORS.purple][v % 5];

    switch (module.type) {
      case 'straight':
        if (module.index > 0) this.addBumpBar(center, 0.12, colorA, jitter(17) * 0.2);
        break;
      case 'slalom':
        for (let i = 0; i < 5; i++) this.addPin((i % 2 ? 2.0 : -2.0) + jitter(i) * 0.6, startZ - 2.2 - i * (span - 4) / 4, 0.34, colorA);
        break;
      case 'pinball':
      case 'bumpers':
        for (let i = 0; i < 9; i++) this.addPin(jitter(i) * 3.8, startZ - 1.8 - (i % 5) * ((span - 3.6) / 4) - Math.floor(i / 5) * 1.1, 0.34 + (i % 3) * 0.05, colorA);
        break;
      case 'spinner':
        this.addSpinner(center, sign, 1, v * 0.01);
        break;
      case 'double-spinner':
        this.addSpinner(startZ - span * 0.35, sign, 0.82, 0);
        this.addSpinner(startZ - span * 0.68, -sign, 0.82, 1.3);
        break;
      case 'split':
        this.addStaticBox({ x: 0, z: center, w: 0.32, h: 0.85, d: span * 0.58, color: colorA, bounce: false });
        break;
      case 'squeeze':
        this.addStaticBox({ x: -4.45, z: center - 1.1, w: 2.7, h: 0.82, d: 2.2, color: colorA, rotY: 0.10 });
        this.addStaticBox({ x: 4.45, z: center + 1.1, w: 2.7, h: 0.82, d: 2.2, color: colorA, rotY: -0.10 });
        break;
      case 'wave':
        this.addBumpBar(startZ - span * 0.32, 0.15, colorA, -0.28);
        this.addBumpBar(startZ - span * 0.5, 0.19, colorA, 0.28);
        this.addBumpBar(startZ - span * 0.69, 0.15, colorA, -0.18);
        break;
      case 'gates':
        this.addMovingGate(startZ - span * 0.37, v * 0.03, 1.05, 2.6, 3.3, colorA);
        this.addMovingGate(startZ - span * 0.68, 1.4 + v * 0.01, 1.3, 2.3, 3.0, COLORS.yellow);
        break;
      case 'stairs':
        for (let i = 0; i < 5; i++) this.addBumpBar(startZ - 2.2 - i * 1.65, 0.13 + i * 0.012, i % 2 ? colorA : COLORS.dark, (i % 2 ? 1 : -1) * 0.28);
        break;
      case 'zigzag':
      case 'switchback':
        for (let i = 0; i < 4; i++) {
          const side = i % 2 ? 1 : -1;
          // Wall-connected deflectors cannot form a marble-sized pocket
          // between the obstacle and the rail.
          this.addStaticBox({ x: side * 4.05, z: startZ - 2.4 - i * (span - 4.8) / 3, w: 3.45, h: 0.56, d: 0.30, color: colorA, rotY: side * 0.28 });
        }
        break;
      case 'gauntlet':
        this.addSpinner(startZ - span * 0.46, sign, 0.88, 0.4);
        this.addMovingGate(startZ - span * 0.72, 0.7, 1.5, 2.1, 3.1, COLORS.accent);
        for (let i = 0; i < 4; i++) this.addPin(jitter(i) * 3.5, startZ - 2.0 - i * 1.4, 0.3, COLORS.yellow);
        break;
      case 'tunnel':
        this.addStaticBox({ x: -4.25, z: center, w: 0.5, h: 2.2, d: span * 0.55, color: colorA, bounce: false });
        this.addStaticBox({ x: 4.25, z: center, w: 0.5, h: 2.2, d: span * 0.55, color: colorA, bounce: false });
        this.addStaticBox({ x: 0, z: center, w: 8.8, h: 0.3, d: span * 0.55, color: colorA, y: this.trackY(center) + 2.25, bounce: false });
        break;
      case 'crossfire':
        this.addSidePuncher(startZ - span * 0.34, -1, 0.1, 1.6);
        this.addSidePuncher(startZ - span * 0.54, 1, 1.1, 1.85);
        this.addSidePuncher(startZ - span * 0.72, -1, 2.0, 2.0);
        break;
      case 'clover':
        for (let i = 0; i < 8; i++) {
          const a = i / 8 * Math.PI * 2;
          this.addPin(Math.cos(a) * 2.3, center + Math.sin(a) * 2.7, 0.37, i % 2 ? colorA : COLORS.yellow);
        }
        break;
      case 'punchers':
        this.addSidePuncher(startZ - span * 0.38, -1, 0, 2.2);
        this.addSidePuncher(startZ - span * 0.62, 1, 0.8, 2.2);
        break;
      case 'dropzone':
        this.addBumpBar(startZ - span * 0.31, 0.18, colorA, -0.22);
        this.addStaticBox({ x: -4.15, z: center, w: 3.0, h: 0.34, d: 1.0, color: COLORS.dark, rotY: 0.12 });
        this.addStaticBox({ x: 4.15, z: center - 1.9, w: 3.0, h: 0.34, d: 1.0, color: COLORS.dark, rotY: -0.12 });
        this.addBumpBar(startZ - span * 0.76, 0.16, COLORS.yellow, 0.22);
        break;
      case 'finale':
        for (let i = 0; i < 3; i++) this.addPin((i - 1) * 2.1, center - i * 0.45, 0.28, colorA);
        break;
    }
  }

  addFinishGate(z) {
    const y = this.trackY(z);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x151922, roughness: 0.38, metalness: 0.2 });
    for (const x of [-WIDTH / 2 + 0.35, WIDTH / 2 - 0.35]) {
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.0, 0.25), poleMat);
      pole.position.set(x, y + 1.5, z);
      pole.castShadow = true;
      this.trackGroup.add(pole);
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(WIDTH - 0.5, 0.52, 0.22), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
    banner.position.set(0, y + 2.75, z);
    banner.castShadow = true;
    this.trackGroup.add(banner);
    const line = new THREE.Mesh(new THREE.BoxGeometry(WIDTH - 0.6, 0.035, 0.55), new THREE.MeshBasicMaterial({ color: 0x1b1f27 }));
    line.position.set(0, y + 0.04, z);
    line.rotation.x = -Math.atan(SLOPE);
    this.trackGroup.add(line);
  }

  async createMarbleTexture(marble) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const drawBase = () => {
      ctx.clearRect(0, 0, 256, 256);
      ctx.fillStyle = marble.color;
      ctx.fillRect(0, 0, 256, 256);
      const grad = ctx.createLinearGradient(0, 0, 256, 256);
      grad.addColorStop(0, 'rgba(255,255,255,.3)');
      grad.addColorStop(.45, 'rgba(255,255,255,0)');
      grad.addColorStop(1, 'rgba(0,0,0,.25)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = 'rgba(255,255,255,.94)';
      ctx.beginPath();
      ctx.arc(128, 128, 58, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#111722';
      ctx.font = '800 64px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(marble.number ?? ''), 128, 131);
    };
    drawBase();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    if (marble.logo) {
      const img = new Image();
      img.onload = () => {
        drawBase();
        ctx.save();
        ctx.beginPath();
        ctx.arc(128, 128, 55, 0, Math.PI * 2);
        ctx.clip();
        const s = Math.min(img.width, img.height);
        const sx = (img.width - s) / 2;
        const sy = (img.height - s) / 2;
        ctx.drawImage(img, sx, sy, s, s, 73, 73, 110, 110);
        ctx.restore();
        texture.needsUpdate = true;
      };
      img.src = marble.logo;
    }
    return texture;
  }

  async setParticipants(marbles) {
    for (const body of this.marbleBodies) this.world.removeBody(body);
    this.marbleBodies.length = 0;
    this.marbleGroup.clear();
    this.marbles.length = 0;
    this.finishResults.length = 0;
    this.currentParticipants = marbles.map(m => m.id);

    const cols = Math.min(8, marbles.length);
    for (let i = 0; i < marbles.length; i++) {
      const m = marbles[i];
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = (col - (Math.min(cols, marbles.length - row * cols) - 1) / 2) * 1.14 + (row % 2 ? 0.25 : 0);
      const z = 3.2 - row * 1.18;
      const y = this.trackY(z) + RADIUS + 0.22;
      const body = new CANNON.Body({
        mass: 1,
        material: this.marbleMaterial,
        shape: new CANNON.Sphere(RADIUS),
        linearDamping: 0.035,
        angularDamping: 0.015,
        sleepSpeedLimit: 0.08,
        sleepTimeLimit: 0.6,
      });
      body.position.set(x, y, z);
      body.allowSleep = true;
      body.sleep();
      this.world.addBody(body);
      this.marbleBodies.push(body);

      const texture = await this.createMarbleTexture(m);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(RADIUS, 24, 18),
        new THREE.MeshStandardMaterial({ map: texture, color: 0xffffff, roughness: 0.28, metalness: 0.06 })
      );
      mesh.position.copy(body.position);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.marbleGroup.add(mesh);

      this.marbles.push({
        data: m, body, mesh, startIndex: i, finished: false, finishTime: null,
        dnf: false, hiddenAt: null, lastProgressZ: z, stuckTime: 0, nudged: false, rescues: 0,
      });
    }
    this.syncMeshes();
  }

  startRace() {
    this.running = true;
    this.simTime = 0;
    this.finishResults = [];
    this.lastHud = 0;
    this.lastAutoCamera = -99;
    for (const item of this.marbles) {
      item.finished = false;
      item.finishTime = null;
      item.dnf = false;
      item.hiddenAt = null;
      item.stuckTime = 0;
      item.nudged = false;
      item.rescues = 0;
      item.body.wakeUp();
      item.body.velocity.set((this.raceRng() - 0.5) * 0.03, 0, -0.02);
      item.body.angularVelocity.set(0, 0, 0);
      item.mesh.visible = true;
    }
  }

  stopRace() { this.running = false; }
  setSpeed(speed) { this.speed = [1,2,4].includes(speed) ? speed : 1; }
  setCamera(mode) { this.cameraMode = mode; }
  follow(id) { this.followId = id; this.cameraMode = 'follow'; }

  getLiveOrder() {
    return [...this.marbles].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return a.body.position.z - b.body.position.z;
    });
  }

  stepRace(dt) {
    for (const k of this.kinematics) k.update(this.simTime);
    this.world.step(FIXED_DT);
    this.simTime += FIXED_DT;

    for (const item of this.marbles) {
      if (item.finished) continue;
      const { body } = item;
      const expectedY = this.trackY(body.position.z);
      const out = Math.abs(body.position.x) > WIDTH / 2 + 1.6 || body.position.y < expectedY - 2.6 || body.position.z > 7;
      if (out) this.rescue(item, true);

      if (body.position.z < item.lastProgressZ - 0.38) {
        item.lastProgressZ = body.position.z;
        item.stuckTime = 0;
        item.nudged = false;
      } else {
        item.stuckTime += dt;
        // One nudge only. The old implementation could impulse every frame,
        // producing the visible forward/backward ping-pong around obstacles.
        if (item.stuckTime > 1.25 && !item.nudged && body.velocity.length() < 1.35) {
          item.nudged = true;
          body.applyImpulse(new CANNON.Vec3((this.raceRng() - 0.5) * 0.6, 0.18, -1.45), body.position);
        }
        if (item.stuckTime >= 2.75) this.rescue(item, false);
      }

      if (body.position.z <= this.finishZ) this.finishMarble(item, false);
    }

    if (this.simTime >= 70) {
      const remaining = this.getLiveOrder().filter(x => !x.finished);
      for (const item of remaining) this.finishMarble(item, true);
    }

    if (this.marbles.length && this.marbles.every(x => x.finished)) {
      this.running = false;
      const results = this.getFinalResults();
      this.callbacks.onFinish?.(results);
    }
  }

  rescue(item, hard = false) {
    item.rescues += 1;
    const z = Math.min(-1, Math.max(this.finishZ + 4, item.lastProgressZ - (hard ? 0.5 : 1.2)));
    const x = Math.max(-3.5, Math.min(3.5, item.body.position.x * 0.35 + (this.raceRng() - 0.5) * 0.8));
    item.body.position.set(x, this.trackY(z) + RADIUS + 0.65, z);
    item.body.velocity.set((this.raceRng() - 0.5) * 0.5, 0, -2.4);
    item.body.angularVelocity.set(0, 0, 0);
    item.lastProgressZ = z;
    item.stuckTime = 0;
    item.nudged = false;
    item.body.wakeUp();
  }

  finishMarble(item, dnf) {
    if (item.finished) return;
    item.finished = true;
    item.dnf = dnf;
    item.finishTime = this.simTime + this.finishResults.length * 0.0001;
    item.body.velocity.set(0, 0, 0);
    item.body.angularVelocity.set(0, 0, 0);
    item.body.collisionFilterMask = 0;
    item.hiddenAt = this.simTime + 0.8;
    this.finishResults.push(item.data.id);
  }

  getFinalResults() {
    const order = this.getLiveOrder();
    return order.map((item, idx) => ({
      id: item.data.id,
      time: +item.finishTime.toFixed(3),
      dnf: item.dnf,
      rescues: item.rescues,
      gain: (item.startIndex + 1) - (idx + 1),
    }));
  }

  syncMeshes() {
    for (const item of this.marbles) {
      item.mesh.position.set(item.body.position.x, item.body.position.y, item.body.position.z);
      item.mesh.quaternion.set(item.body.quaternion.x, item.body.quaternion.y, item.body.quaternion.z, item.body.quaternion.w);
      if (item.hiddenAt && this.simTime >= item.hiddenAt) item.mesh.visible = false;
    }
  }

  updateCamera(realTime) {
    const order = this.getLiveOrder();
    if (!order.length) return;
    let target = null;
    let mode = this.cameraMode;

    if (mode === 'auto') {
      if (realTime - this.lastAutoCamera > 4.2) {
        this.lastAutoCamera = realTime;
        const candidates = order.filter(x => !x.finished).slice(0, Math.min(5, order.length));
        this.autoTargetId = candidates[Math.floor(Math.random() * candidates.length)]?.data.id ?? order[0].data.id;
      }
      target = order.find(x => x.data.id === this.autoTargetId) ?? order[0];
      if (Math.floor(realTime / 8) % 3 === 2) mode = 'overview';
    } else if (mode === 'leader') {
      target = order[0];
    } else if (mode === 'follow') {
      target = order.find(x => x.data.id === this.followId) ?? order[0];
    }

    if (mode === 'overview') {
      const active = order.filter(x => !x.finished);
      const z = active.length ? active.reduce((s, x) => s + x.body.position.z, 0) / active.length : this.finishZ;
      const y = this.trackY(z);
      const desired = new THREE.Vector3(0, y + 17, z + 8);
      this.camera.position.lerp(desired, 0.055);
      this.camera.lookAt(0, y, z - 8);
      return;
    }

    target ??= order[0];
    const p = target.body.position;
    const side = mode === 'auto' && Math.floor(realTime / 4) % 2 ? 1 : -1;
    const desired = new THREE.Vector3(p.x + side * 5.3, p.y + 4.1, p.z + 8.4);
    this.camera.position.lerp(desired, 0.075);
    this.camera.lookAt(p.x * 0.55, p.y + 0.2, p.z - 4.8);
  }

  animate(ms) {
    const realTime = ms / 1000;
    if (this.running) {
      const steps = this.speed;
      for (let i = 0; i < steps; i++) this.stepRace(FIXED_DT);
    }
    this.syncMeshes();
    this.updateCamera(realTime);

    if (this.running && ms - this.lastHud > 120) {
      this.lastHud = ms;
      const order = this.getLiveOrder();
      this.callbacks.onUpdate?.({
        time: this.simTime,
        progress: Math.min(1, Math.max(0, order[0] ? -order[0].body.position.z / Math.abs(this.finishZ) : 0)),
        order: order.map((x, i) => ({ id: x.data.id, position: i + 1, finished: x.finished, dnf: x.dnf }))
      });
    }

    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.animate);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
}
