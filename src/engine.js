import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { rngFromSeed, generateTrackPath } from './logic.js';

const WIDTH = 10.5;
const START_Y = 4.1;
const SLOPE = 0.135;
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
      friction: 0.09, restitution: 0.18,
    }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.marbleMaterial, this.obstacleMaterial, {
      friction: 0.045, restitution: 0.58,
    }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.marbleMaterial, this.marbleMaterial, {
      friction: 0.025, restitution: 0.34,
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
    this.pathSamples = [];
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

  trackPose(z) {
    const pts = this.pathSamples;
    if (!pts?.length) return { x: 0, y: START_Y + SLOPE * z, z, yaw: 0 };
    if (z >= pts[0].z) {
      const a = pts[0], b = pts[Math.min(1, pts.length - 1)];
      return { x: a.x, y: a.y, z, yaw: Math.atan2(b.x - a.x, -(b.z - a.z)) };
    }
    if (z <= pts.at(-1).z) {
      const a = pts[Math.max(0, pts.length - 2)], b = pts.at(-1);
      return { x: b.x, y: b.y, z, yaw: Math.atan2(b.x - a.x, -(b.z - a.z)) };
    }
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].z >= z) lo = mid;
      else hi = mid;
    }
    const a = pts[lo], b = pts[hi];
    const t = (z - a.z) / (b.z - a.z);
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z,
      yaw: Math.atan2(b.x - a.x, -(b.z - a.z)),
    };
  }

  trackY(z) { return this.trackPose(z).y; }
  trackX(z) { return this.trackPose(z).x; }

  localPoint(offset, z) {
    const pose = this.trackPose(z);
    const nx = Math.cos(pose.yaw);
    const nz = Math.sin(pose.yaw);
    return { x: pose.x + offset * nx, y: pose.y, z: pose.z + offset * nz, yaw: pose.yaw, nx, nz };
  }

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
    this.pathSamples = generateTrackPath(plan, { startY: START_Y, slope: SLOPE, maxX: 13.5 });
    this.finishZ = -(plan.totalLength - 1.4);
    this.raceRng = rngFromSeed(`physics:${plan.seed}:${plan.format}`);

    for (let i = 0; i < this.pathSamples.length - 1; i++) {
      this.addTrackSlice(this.pathSamples[i], this.pathSamples[i + 1], i);
    }

    let cursor = 0;
    for (const module of plan.modules) {
      const startZ = -cursor;
      const endZ = -(cursor + module.length);
      this.decorateModule(module, startZ, endZ);
      this.addSupport((startZ + endZ) / 2, module.index);
      cursor += module.length;
    }
    this.addFinishGate(this.finishZ);
    const start = this.trackPose(-8);
    this.camera.position.set(start.x, start.y + 11, 17);
    this.camera.lookAt(start.x, start.y, -9);
  }

  addTrackSlice(a, b, index = 0) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const horizontal = Math.max(0.01, Math.hypot(dx, dz));
    const length = horizontal + 0.26;
    const centerX = (a.x + b.x) / 2;
    const centerZ = (a.z + b.z) / 2;
    const centerY = (a.y + b.y) / 2;
    const yaw = Math.atan2(dx, -dz);
    const pitch = -Math.atan2(a.y - b.y, horizontal);
    const rotY = -yaw;
    const colorShift = Math.floor(index / 4) % 2 === 0 ? COLORS.floor : 0xf2f5f8;
    const mat = new THREE.MeshStandardMaterial({ color: colorShift, roughness: 0.76, metalness: 0.02 });

    const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(WIDTH, FLOOR_THICKNESS, length), mat);
    floorMesh.position.set(centerX, centerY - FLOOR_THICKNESS / 2, centerZ);
    floorMesh.rotation.set(pitch, rotY, 0);
    floorMesh.receiveShadow = true;
    this.trackGroup.add(floorMesh);

    const floorBody = new CANNON.Body({ mass: 0, material: this.trackMaterial });
    floorBody.addShape(new CANNON.Box(new CANNON.Vec3(WIDTH / 2, FLOOR_THICKNESS / 2, length / 2)));
    floorBody.position.set(centerX, centerY - FLOOR_THICKNESS / 2, centerZ);
    floorBody.quaternion.setFromEuler(pitch, rotY, 0);
    this.world.addBody(floorBody);
    this.trackBodies.push(floorBody);

    const nx = Math.cos(yaw), nz = Math.sin(yaw);
    for (const side of [-1, 1]) {
      const wx = centerX + side * (WIDTH / 2 + 0.02) * nx;
      const wz = centerZ + side * (WIDTH / 2 + 0.02) * nz;
      const wallMesh = new THREE.Mesh(new THREE.BoxGeometry(0.28, WALL_H, length), this.wallMat);
      wallMesh.position.set(wx, centerY + WALL_H / 2 - 0.05, wz);
      wallMesh.rotation.set(pitch, rotY, 0);
      wallMesh.castShadow = true;
      wallMesh.receiveShadow = true;
      this.trackGroup.add(wallMesh);

      const body = new CANNON.Body({ mass: 0, material: this.trackMaterial });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.14, WALL_H / 2, length / 2)));
      body.position.set(wx, centerY + WALL_H / 2 - 0.05, wz);
      body.quaternion.setFromEuler(pitch, rotY, 0);
      this.world.addBody(body);
      this.trackBodies.push(body);
    }
  }

  addSupport(z, index = 0) {
    const p = this.localPoint(index % 2 ? 3.8 : -3.8, z);
    const support = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.24, 4.2, 8),
      new THREE.MeshStandardMaterial({ color: 0xaab4c3, roughness: 0.85 })
    );
    support.position.set(p.x, p.y - 2.25, p.z);
    support.castShadow = true;
    this.trackGroup.add(support);
  }

  addStaticBox({ x = 0, z, w = 1, h = 1, d = 1, color = COLORS.dark, rotY = 0, y = null, bounce = true }) {
    const p = this.localPoint(x, z);
    const yy = y ?? (p.y + h / 2 + 0.05);
    const worldRotY = -p.yaw + rotY;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.48, metalness: 0.08 })
    );
    mesh.position.set(p.x, yy, p.z);
    mesh.rotation.y = worldRotY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.trackGroup.add(mesh);

    const body = new CANNON.Body({ mass: 0, material: bounce ? this.obstacleMaterial : this.trackMaterial });
    body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
    body.position.set(p.x, yy, p.z);
    body.quaternion.setFromEuler(0, worldRotY, 0);
    this.world.addBody(body);
    this.trackBodies.push(body);
    return { mesh, body };
  }

  addPin(x, z, radius = 0.36, color = COLORS.accent2) {
    const h = 1.2;
    const p = this.localPoint(x, z);
    const y = p.y + h / 2 + 0.05;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, h, 12),
      new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.12 })
    );
    mesh.position.set(p.x, y, p.z);
    mesh.castShadow = true;
    this.trackGroup.add(mesh);
    const body = new CANNON.Body({ mass: 0, material: this.obstacleMaterial });
    body.addShape(new CANNON.Cylinder(radius, radius, h, 12));
    body.position.set(p.x, y, p.z);
    this.world.addBody(body);
    this.trackBodies.push(body);
  }

  addBumpBar(z, radius = 0.18, color = COLORS.yellow, offset = 0) {
    // These are deliberately lane-sized speed bumps, not cross-track logs.
    // A marble may hit one, but the majority of the track always remains open.
    const safeRadius = Math.min(radius, 0.18);
    const barLen = 2.15;
    const safeOffset = Math.max(-3.55, Math.min(3.55, offset));
    const p = this.localPoint(safeOffset, z);
    const y = p.y + safeRadius + 0.045;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(safeRadius, safeRadius, barLen, 12),
      new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.05 })
    );
    mesh.position.set(p.x, y, p.z);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -p.yaw);
    const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    mesh.quaternion.copy(qYaw).multiply(qRoll);
    mesh.castShadow = true;
    this.trackGroup.add(mesh);

    const body = new CANNON.Body({ mass: 0, material: this.obstacleMaterial });
    const shape = new CANNON.Cylinder(safeRadius, safeRadius, barLen, 12);
    const cqYaw = new CANNON.Quaternion(); cqYaw.setFromEuler(0, -p.yaw, 0);
    const cqRoll = new CANNON.Quaternion(); cqRoll.setFromEuler(0, 0, Math.PI / 2);
    const cq = cqYaw.mult(cqRoll);
    body.addShape(shape, new CANNON.Vec3(), cq);
    body.position.set(p.x, y, p.z);
    this.world.addBody(body);
    this.trackBodies.push(body);
  }

  addSpinner(z, direction = 1, scale = 1, phase = 0) {
    const p = this.localPoint(0, z);
    const y = p.y + 0.64;
    const barLen = 5.35 * scale;
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: COLORS.purple, roughness: 0.34, metalness: 0.12 });
    for (const ry of [0, Math.PI / 2]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(barLen, 0.22, 0.30), mat);
      bar.rotation.y = ry;
      bar.castShadow = true;
      group.add(bar);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.46, 16), this.darkMat);
    hub.castShadow = true;
    group.add(hub);
    group.position.set(p.x, y, p.z);
    this.trackGroup.add(group);

    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: this.obstacleMaterial });
    const box = new CANNON.Box(new CANNON.Vec3(barLen / 2, 0.11, 0.15));
    body.addShape(box);
    const q2 = new CANNON.Quaternion(); q2.setFromEuler(0, Math.PI / 2, 0);
    body.addShape(box, new CANNON.Vec3(), q2);
    body.position.set(p.x, y, p.z);
    this.world.addBody(body);
    this.trackBodies.push(body);
    this.kinematics.push({
      body, mesh: group,
      update: (t) => {
        const angle = phase + t * direction * (1.0 + 0.38 * scale);
        body.quaternion.setFromEuler(0, -p.yaw + angle, 0);
        body.angularVelocity.set(0, direction * (1.0 + 0.38 * scale), 0);
        group.rotation.y = -p.yaw + angle;
        body.aabbNeedsUpdate = true;
      }
    });
  }

  addMovingGate(z, phase = 0, speed = 1.2, width = 2.4, amp = 3.2, color = COLORS.accent) {
    const h = 0.82;
    const center = this.localPoint(0, z);
    const y = center.y + h / 2 + 0.12;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, h, 0.34),
      new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.08 })
    );
    mesh.castShadow = true;
    mesh.rotation.y = -center.yaw;
    this.trackGroup.add(mesh);
    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: this.obstacleMaterial });
    body.addShape(new CANNON.Box(new CANNON.Vec3(width / 2, h / 2, 0.17)));
    body.quaternion.setFromEuler(0, -center.yaw, 0);
    this.world.addBody(body);
    this.trackBodies.push(body);
    this.kinematics.push({
      body, mesh,
      update: (t) => {
        const offset = Math.sin(t * speed + phase) * amp;
        const p = this.localPoint(offset, z);
        const lateralV = Math.cos(t * speed + phase) * amp * speed;
        body.position.set(p.x, y, p.z);
        body.velocity.set(p.nx * lateralV, 0, p.nz * lateralV);
        mesh.position.set(p.x, y, p.z);
        body.aabbNeedsUpdate = true;
      }
    });
  }

  addSidePuncher(z, side = -1, phase = 0, speed = 1.7) {
    const w = 1.85, h = 0.78, d = 0.62;
    const center = this.localPoint(0, z);
    const y = center.y + h / 2 + 0.1;
    const base = side * 4.45;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color: COLORS.mint, roughness: 0.35, metalness: 0.06 })
    );
    mesh.castShadow = true;
    mesh.rotation.y = -center.yaw;
    this.trackGroup.add(mesh);
    const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: this.obstacleMaterial });
    body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
    body.quaternion.setFromEuler(0, -center.yaw, 0);
    this.world.addBody(body);
    this.trackBodies.push(body);
    this.kinematics.push({
      body, mesh,
      update: (t) => {
        const travel = (Math.sin(t * speed + phase) + 1) * 0.5 * 1.65;
        const offset = base - side * travel;
        const p = this.localPoint(offset, z);
        const lateralV = -side * Math.cos(t * speed + phase) * 1.65 * speed * 0.5;
        body.position.set(p.x, y, p.z);
        body.velocity.set(p.nx * lateralV, 0, p.nz * lateralV);
        mesh.position.set(p.x, y, p.z);
        body.aabbNeedsUpdate = true;
      }
    });
  }

  addTunnelArch(z, color = COLORS.accent2) {
    const postH = 2.15;
    this.addStaticBox({ x: -4.6, z, w: 0.28, h: postH, d: 0.32, color, bounce: false });
    this.addStaticBox({ x: 4.6, z, w: 0.28, h: postH, d: 0.32, color, bounce: false });
    const p = this.localPoint(0, z);
    this.addStaticBox({ x: 0, z, w: 9.4, h: 0.24, d: 0.32, color, y: p.y + 2.18, bounce: false });
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
        if (module.index > 0) this.addBumpBar(center, 0.11, colorA, jitter(17) * 2.8);
        break;
      case 'slalom':
        for (let i = 0; i < 5; i++) this.addPin((i % 2 ? 1.85 : -1.85) + jitter(i) * 0.45, startZ - 2.2 - i * (span - 4) / 4, 0.30, colorA);
        break;
      case 'pinball':
      case 'bumpers':
        for (let i = 0; i < 8; i++) this.addPin(jitter(i) * 3.55, startZ - 1.8 - (i % 4) * ((span - 3.6) / 3) - Math.floor(i / 4) * 1.05, 0.29 + (i % 3) * 0.035, colorA);
        break;
      case 'spinner':
        this.addSpinner(center, sign, 0.82, v * 0.01);
        break;
      case 'double-spinner':
        this.addSpinner(startZ - span * 0.35, sign, 0.68, 0);
        this.addSpinner(startZ - span * 0.68, -sign, 0.68, 1.3);
        break;
      case 'split':
        this.addStaticBox({ x: 0, z: center, w: 0.25, h: 0.68, d: span * 0.42, color: colorA, bounce: false });
        break;
      case 'squeeze': {
        // True downstream funnel: wide entrance, tips point toward the centre
        // and DOWN the hill. The previous sign made the geometry an inverse funnel.
        for (const side of [-1, 1]) {
          this.addStaticBox({
            x: side * 4.15, z: center, w: 2.15, h: 0.48, d: 0.28,
            color: colorA, rotY: -side * 0.34,
          });
        }
        break;
      }
      case 'wave':
        this.addBumpBar(startZ - span * 0.30, 0.12, colorA, -2.7);
        this.addBumpBar(startZ - span * 0.49, 0.15, colorA, 1.8);
        this.addBumpBar(startZ - span * 0.68, 0.12, colorA, -0.4);
        this.addBumpBar(startZ - span * 0.80, 0.11, COLORS.yellow, 3.0);
        break;
      case 'gates':
        this.addMovingGate(startZ - span * 0.37, v * 0.03, 1.0, 2.15, 2.85, colorA);
        this.addMovingGate(startZ - span * 0.68, 1.4 + v * 0.01, 1.2, 2.0, 2.75, COLORS.yellow);
        break;
      case 'stairs':
        // Staggered lane bumps rather than full-width logs.
        for (let i = 0; i < 6; i++) {
          const lane = [-3.0, 0.2, 2.85, -1.55, 1.65, -2.65][i];
          this.addBumpBar(startZ - 1.8 - i * 1.45, 0.105 + (i % 2) * 0.018, i % 2 ? colorA : COLORS.dark, lane);
        }
        break;
      case 'zigzag':
        for (let i = 0; i < 4; i++) {
          const side = i % 2 ? 1 : -1;
          // Connected to the wall with the tip pointing downstream, so contact
          // redirects a marble rather than forming a pocket against the rail.
          this.addStaticBox({
            x: side * 4.1,
            z: startZ - 2.4 - i * (span - 4.8) / 3,
            w: 2.25, h: 0.48, d: 0.27, color: colorA,
            rotY: -side * 0.36,
          });
        }
        break;
      case 'switchback':
        // The track itself now performs the switchback. Obstacles stay tiny.
        for (let i = 0; i < 4; i++) this.addPin(jitter(i + 30) * 2.7, startZ - 2.2 - i * (span - 4.4) / 3, 0.27, i % 2 ? colorA : COLORS.yellow);
        break;
      case 'gauntlet':
        this.addSpinner(startZ - span * 0.45, sign, 0.70, 0.4);
        this.addMovingGate(startZ - span * 0.72, 0.7, 1.35, 1.9, 2.75, COLORS.accent);
        for (let i = 0; i < 3; i++) this.addPin(jitter(i) * 3.2, startZ - 2.0 - i * 1.55, 0.27, COLORS.yellow);
        break;
      case 'tunnel':
        for (let i = 0; i < 4; i++) this.addTunnelArch(startZ - 2.0 - i * (span - 4.0) / 3, i % 2 ? colorA : COLORS.dark);
        break;
      case 'spiral':
        // The centreline performs a descending double sweep; arches make the
        // corkscrew motion readable without enclosing the marbles in a tube.
        for (let i = 0; i < 5; i++) this.addTunnelArch(startZ - 1.8 - i * (span - 3.6) / 4, i % 2 ? colorA : COLORS.purple);
        this.addPin(-2.0 * sign, center - 0.8, 0.27, COLORS.yellow);
        this.addPin(2.0 * sign, center + 1.1, 0.27, colorA);
        break;
      case 'crossfire':
        this.addSidePuncher(startZ - span * 0.34, -1, 0.1, 1.45);
        this.addSidePuncher(startZ - span * 0.55, 1, 1.1, 1.65);
        this.addSidePuncher(startZ - span * 0.73, -1, 2.0, 1.8);
        break;
      case 'clover':
        for (let i = 0; i < 7; i++) {
          const a = i / 7 * Math.PI * 2;
          this.addPin(Math.cos(a) * 2.2, center + Math.sin(a) * 2.45, 0.30, i % 2 ? colorA : COLORS.yellow);
        }
        break;
      case 'punchers':
        this.addSidePuncher(startZ - span * 0.38, -1, 0, 1.95);
        this.addSidePuncher(startZ - span * 0.64, 1, 0.8, 1.95);
        break;
      case 'dropzone':
        // This module gets a steeper physical descent from generateTrackPath.
        this.addBumpBar(startZ - span * 0.30, 0.12, colorA, -2.5);
        this.addPin(2.75, center + 1.0, 0.28, COLORS.dark);
        this.addPin(-2.3, center - 1.1, 0.28, COLORS.dark);
        this.addBumpBar(startZ - span * 0.76, 0.11, COLORS.yellow, 2.4);
        break;
      case 'finale':
        for (let i = 0; i < 3; i++) this.addPin((i - 1) * 2.0, center - i * 0.42, 0.25, colorA);
        break;
    }
  }

  addFinishGate(z) {
    const pose = this.trackPose(z);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x151922, roughness: 0.38, metalness: 0.2 });
    for (const offset of [-WIDTH / 2 + 0.35, WIDTH / 2 - 0.35]) {
      const p = this.localPoint(offset, z);
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.0, 0.25), poleMat);
      pole.position.set(p.x, pose.y + 1.5, p.z);
      pole.rotation.y = -pose.yaw;
      pole.castShadow = true;
      this.trackGroup.add(pole);
    }
    const bannerP = this.localPoint(0, z);
    const banner = new THREE.Mesh(new THREE.BoxGeometry(WIDTH - 0.5, 0.52, 0.22), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
    banner.position.set(bannerP.x, pose.y + 2.75, bannerP.z);
    banner.rotation.y = -pose.yaw;
    banner.castShadow = true;
    this.trackGroup.add(banner);
    const line = new THREE.Mesh(new THREE.BoxGeometry(WIDTH - 0.6, 0.035, 0.55), new THREE.MeshBasicMaterial({ color: 0x1b1f27 }));
    line.position.set(bannerP.x, pose.y + 0.04, bannerP.z);
    line.rotation.set(-Math.atan(SLOPE), -pose.yaw, 0);
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
      const lane = (col - (Math.min(cols, marbles.length - row * cols) - 1) / 2) * 1.14 + (row % 2 ? 0.25 : 0);
      const z = 3.2 - row * 1.18;
      const p = this.localPoint(lane, z);
      const y = p.y + RADIUS + 0.22;
      const body = new CANNON.Body({
        mass: 1,
        material: this.marbleMaterial,
        shape: new CANNON.Sphere(RADIUS),
        linearDamping: 0.018,
        angularDamping: 0.010,
        sleepSpeedLimit: 0.06,
        sleepTimeLimit: 0.75,
      });
      body.position.set(p.x, y, p.z);
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
      const pose = this.trackPose(item.body.position.z);
      const forwardX = Math.sin(pose.yaw), forwardZ = -Math.cos(pose.yaw);
      const lateral = (this.raceRng() - 0.5) * 0.035;
      item.body.velocity.set(forwardX * 0.04 + Math.cos(pose.yaw) * lateral, 0, forwardZ * 0.04 + Math.sin(pose.yaw) * lateral);
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
      const pose = this.trackPose(body.position.z);
      const dx = body.position.x - pose.x;
      const dz = body.position.z - pose.z;
      const lateral = dx * Math.cos(pose.yaw) + dz * Math.sin(pose.yaw);
      const out = Math.abs(lateral) > WIDTH / 2 + 1.75 || body.position.y < pose.y - 2.8 || body.position.z > 7;
      if (out) this.rescue(item, true);

      if (body.position.z < item.lastProgressZ - 0.36) {
        item.lastProgressZ = body.position.z;
        item.stuckTime = 0;
        item.nudged = false;
      } else {
        item.stuckTime += dt;
        if (item.stuckTime > 1.15 && !item.nudged && body.velocity.length() < 1.6) {
          item.nudged = true;
          const p = this.trackPose(body.position.z);
          const fx = Math.sin(p.yaw), fz = -Math.cos(p.yaw);
          const nx = Math.cos(p.yaw), nz = Math.sin(p.yaw);
          const side = (this.raceRng() - 0.5) * 0.62;
          body.applyImpulse(new CANNON.Vec3(fx * 1.72 + nx * side, 0.22, fz * 1.72 + nz * side), body.position);
        }
        if (item.stuckTime >= 2.45) this.rescue(item, false);
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
    const z = Math.min(-1, Math.max(this.finishZ + 4, item.lastProgressZ - (hard ? 0.7 : 1.45)));
    const oldPose = this.trackPose(item.body.position.z);
    const oldDx = item.body.position.x - oldPose.x;
    const oldDz = item.body.position.z - oldPose.z;
    const oldLane = oldDx * Math.cos(oldPose.yaw) + oldDz * Math.sin(oldPose.yaw);
    const lane = Math.max(-3.2, Math.min(3.2, oldLane * 0.28 + (this.raceRng() - 0.5) * 0.85));
    const p = this.localPoint(lane, z);
    const fx = Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const nx = Math.cos(p.yaw), nz = Math.sin(p.yaw);
    const side = (this.raceRng() - 0.5) * 0.42;
    item.body.position.set(p.x, p.y + RADIUS + 0.62, p.z);
    item.body.velocity.set(fx * 2.75 + nx * side, 0.02, fz * 2.75 + nz * side);
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
      const z = active.length ? active.reduce((sum, x) => sum + x.body.position.z, 0) / active.length : this.finishZ;
      const pose = this.trackPose(z);
      const desired = new THREE.Vector3(pose.x, pose.y + 18, z + 9);
      this.camera.position.lerp(desired, 0.055);
      const ahead = this.trackPose(z - 8);
      this.camera.lookAt(ahead.x, ahead.y, ahead.z);
      return;
    }

    target ??= order[0];
    const p = target.body.position;
    const pose = this.trackPose(p.z);
    const side = mode === 'auto' && Math.floor(realTime / 4) % 2 ? 1 : -1;
    const fx = Math.sin(pose.yaw), fz = -Math.cos(pose.yaw);
    const nx = Math.cos(pose.yaw), nz = Math.sin(pose.yaw);
    const desired = new THREE.Vector3(
      p.x + side * nx * 5.0 - fx * 8.0,
      p.y + 4.15,
      p.z + side * nz * 5.0 - fz * 8.0
    );
    this.camera.position.lerp(desired, 0.075);
    this.camera.lookAt(p.x + fx * 4.7, p.y + 0.15, p.z + fz * 4.7);
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
