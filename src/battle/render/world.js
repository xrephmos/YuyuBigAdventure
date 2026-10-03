import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { labelTexture, gridTexture, LabelSprite } from "./textures.js";
import { drawPixelHeart } from "../pixelHeart.js";
import {
  makeHero,
  makeMonster,
  makeProp,
  makeChest,
  makePotion,
  makeKey,
  makeDoor,
  makeExit,
  makeForge,
  makePlate,
  makeCarpet,
  MATERIALS,
} from "./models.js";
import { countHearts } from "../logic/shapes.js";
import { key, isVisible, isExplored } from "../logic/board.js";

/** 棋盘道具种类 → 模型工厂。新增道具只需在这里登记一行。 */
const ITEM_MODELS = { chest: makeChest, potion: makePotion, forge: makeForge, key: makeKey, plate: makePlate };

const SIZE = 8;
const SURFACE = 0.05;
const ease = {
  linear: (t) => t,
  out: (t) => 1 - (1 - t) ** 3,
  inOut: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
};

/**
 * 默认镜头（开局、重置视角时回到这里），按横屏 / 竖屏各一套：
 *   polar        俯仰角：镜头与竖直方向的夹角（度）。0 是正上方往下看，越大越“平视”。
 *   azimuth      方位角：镜头绕棋盘中心往左偏多少度（从 A 列那一侧斜着看），
 *                棋盘不再横平竖直，立体感更强。
 *   minDistance  镜头离棋盘中心的最近距离。
 *   fitHalfWidth 画面左右至少要装下的半宽（含边框），屏幕越窄镜头退得越远。
 * 竖屏俯仰角比横屏小（更俯视）：手机画面窄而高，太平的话远处一排会被压扁。
 */
const HOME_VIEW = {
  landscape: { polar: 42, azimuth: 8, minDistance: 15.4, fitHalfWidth: 5.6 },
  portrait: { polar: 33, azimuth: 8, minDistance: 16.4, fitHalfWidth: 5.1 },
};

/** 把一套默认镜头参数换算成“从棋盘中心指向镜头”的单位向量（镜头在棋盘的 +z 一侧，往 −x 偏）。 */
function homeDirection({ polar, azimuth }) {
  const p = THREE.MathUtils.degToRad(polar);
  const a = THREE.MathUtils.degToRad(azimuth);
  return new THREE.Vector3(-Math.sin(a) * Math.sin(p), Math.cos(p), Math.cos(a) * Math.sin(p));
}

export const tileCenter =(r, c) => new THREE.Vector3(c - (SIZE - 1) / 2, SURFACE, r - (SIZE - 1) / 2);

function seeded(seed) {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** 把棋盘状态画成一张摆在书桌上的实体棋盘。 */
export class BoardWorld {
  constructor(container) {
    this.container = container;
    this.tweens = [];
    /** 每画一帧之后调用的回调（例如让页面上的指引标记跟着镜头走），见 onFrame。 */
    this.frameHooks = new Set();
    this.handlers = { click: () => {}, hover: () => {} };
    this.monsters = new Map();
    this.items = new Map();
    this.doors = new Map();
    this.particles = [];
    this.timer = new THREE.Timer();
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    // 中性浅灰环境，与界面的 --paper / --grey-1 同一色系。
    scene.background = new THREE.Color("#ebeae6");
    scene.fog = new THREE.Fog("#ebeae6", 22, 46);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.45;
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.camera.position.set(0, 11.4, 10.3);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.target.set(0, 0, 0.3);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 20;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.2;
    this.controls.update();
    this.homeView = { pos: this.camera.position.clone(), target: this.controls.target.clone() };

    this.buildLights();
    this.buildTable();
    this.buildBoard();
    this.levelGroup = new THREE.Group();
    scene.add(this.levelGroup);
    this.buildHeartSprite();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) return;
      for (const tw of this.tweens) {
        tw.update(1);
        tw.resolve();
      }
      this.tweens = [];
    });
    this.resize();
    renderer.setAnimationLoop((timestamp) => this.frame(timestamp));
  }

  on(event, handler) {
    this.handlers[event] = handler;
  }

  buildLights() {
    const hemi = new THREE.HemisphereLight("#ffffff", "#bdbdb8", 0.95);
    const lamp = new THREE.DirectionalLight("#ffffff", 2.3);
    lamp.position.set(-5.5, 11, 4.5);
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(2048, 2048);
    lamp.shadow.camera.left = -7;
    lamp.shadow.camera.right = 7;
    lamp.shadow.camera.top = 7;
    lamp.shadow.camera.bottom = -7;
    lamp.shadow.camera.far = 30;
    lamp.shadow.bias = -0.0004;
    lamp.shadow.normalBias = 0.02;
    lamp.shadow.radius = 4;
    const rim = new THREE.DirectionalLight("#e6ebff", 0.35);
    rim.position.set(6, 5, -8);
    const glow = new THREE.SpotLight("#ffffff", 8, 22, 0.55, 0.8, 1.4);
    glow.position.set(-2, 9, 1);
    glow.target.position.set(0, 0, 0);
    this.scene.add(hemi, lamp, rim, glow, glow.target);
  }

  buildTable() {
    // 桌面是一张印着极细网格的灰白纸面：网格线与棋格对齐，呼应界面的瑞士网格。
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ map: gridTexture(15), roughness: 0.9, metalness: 0 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.32;
    table.receiveShadow = true;
    this.scene.add(table);
  }

  /** 扁平棋盘：纸白与浅灰两色方格，墨黑细线勾边，等宽字体坐标。 */
  buildBoard() {
    const board = new THREE.Group();
    const flat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
    const inkLine = new THREE.MeshBasicMaterial({ color: "#0a0a0a" });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.36, 9.2), flat("#fafaf8"));
    slab.position.y = -0.14;
    slab.receiveShadow = true;
    slab.castShadow = true;
    // 棋盘底板与两圈外框放在一组里：有的章节只显示 7 列，整组按列数收窄、平移到中间。
    const frame = new THREE.Group();
    frame.add(slab);
    board.add(frame);
    this.boardFrame = frame;
    this.boardSlab = slab;
    // 两圈细线：棋格外框与棋盘外缘。
    for (const half of [4.0, 4.6])
      for (const [x, z, w, d] of [
        [0, -half, half * 2 + 0.03, 0.03],
        [0, half, half * 2 + 0.03, 0.03],
        [-half, 0, 0.03, half * 2 + 0.03],
        [half, 0, 0.03, half * 2 + 0.03],
      ]) {
        const line = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), inkLine);
        line.position.set(x, half === 4.0 ? SURFACE + 0.002 : 0.046, z);
        frame.add(line);
      }

    const lightMat = flat("#fafaf8");
    const darkMat = flat("#c6c5c0");
    this.tileMats = { light: lightMat, dark: darkMat, plain: flat("#f4f3ef") };
    this.boardGroup = board;
    this.boardLabels = [];
    const tileGeo = new THREE.BoxGeometry(1, 0.1, 1);
    this.tiles = [];
    const overlayGeo = new THREE.PlaneGeometry(0.94, 0.94);
    this.overlays = [];
    this.markMaterials = this.buildMarkMaterials();
    for (let r = 0; r < SIZE; r += 1)
      for (let c = 0; c < SIZE; c += 1) {
        const tile = new THREE.Mesh(tileGeo, (r + c) % 2 === 0 ? lightMat : darkMat);
        const p = tileCenter(r, c);
        tile.position.set(p.x, 0, p.z);
        tile.receiveShadow = true;
        tile.userData = { r, c };
        board.add(tile);
        this.tiles.push(tile);
        const overlay = new THREE.Mesh(overlayGeo, this.markMaterials.move);
        overlay.rotation.x = -Math.PI / 2;
        overlay.position.set(p.x, SURFACE + 0.004, p.z);
        overlay.visible = false;
        overlay.renderOrder = 2;
        board.add(overlay);
        this.overlays.push(overlay);
      }

    const letters = "abcdefgh";
    const labelMat = (text) =>
      new THREE.MeshBasicMaterial({ map: labelTexture(text), transparent: true, depthWrite: false, toneMapped: false });
    for (let i = 0; i < SIZE; i += 1) {
      const letter = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), labelMat(letters[i].toUpperCase()));
      letter.rotation.x = -Math.PI / 2;
      letter.position.set(i - 3.5, 0.047, 4.3);
      const number = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), labelMat(String(SIZE - i)));
      number.rotation.x = -Math.PI / 2;
      number.position.set(-4.3, 0.047, i - 3.5);
      board.add(letter, number);
      this.boardLabels.push(letter, number);
    }
    this.scene.add(board);
    this.buildFog(board);
  }

  /**
   * 迷雾层：未探索的格子盖一块带细斜线的灰白板，遮住上面的一切；
   * 探索过但当前看不见的格子铺一层半透明纸色薄纱。
   */
  buildFog(board) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#e2e1dc";
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = "rgba(10, 10, 10, 0.16)";
    ctx.lineWidth = 2;
    for (let i = -128; i < 256; i += 16) {
      ctx.beginPath();
      ctx.moveTo(i, 128);
      ctx.lineTo(i + 128, 0);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const coverTop = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
    const coverSide = new THREE.MeshStandardMaterial({ color: "#d4d3ce", roughness: 1 });
    // 迷雾块略低于障碍（0.36），既能盖住地面上的东西，又不会挡住太多视线。
    const FOG_HEIGHT = 0.3;
    const coverGeo = new THREE.BoxGeometry(1.001, FOG_HEIGHT, 1.001);
    const veilMat = new THREE.MeshBasicMaterial({
      color: "#fafaf8",
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      toneMapped: false,
    });
    const veilGeo = new THREE.PlaneGeometry(1, 1);
    this.fogCovers = [];
    this.fogVeils = [];
    for (let r = 0; r < SIZE; r += 1)
      for (let c = 0; c < SIZE; c += 1) {
        const p = tileCenter(r, c);
        const cover = new THREE.Mesh(coverGeo, [coverSide, coverSide, coverTop, coverSide, coverSide, coverSide]);
        cover.position.set(p.x, SURFACE + FOG_HEIGHT / 2, p.z);
        cover.receiveShadow = true;
        cover.visible = false;
        cover.userData = { r, c };
        const veil = new THREE.Mesh(veilGeo, veilMat);
        veil.rotation.x = -Math.PI / 2;
        veil.position.set(p.x, SURFACE + 0.003, p.z);
        veil.visible = false;
        veil.renderOrder = 1;
        board.add(cover, veil);
        this.fogCovers.push(cover);
        this.fogVeils.push(veil);
      }
    // 迷雾板也要能被点击拾取（点到迷雾里的格子时给出提示）。
    this.pickTargets = [...this.tiles, ...this.fogCovers];
  }

  /** 按棋盘的可见性刷新迷雾与各物体的显隐。 */
  updateFog(board) {
    const fog = Boolean(board.fog);
    this.fogCovers.forEach((cover, i) => {
      const r = Math.floor(i / SIZE);
      const c = i % SIZE;
      cover.visible = fog && !isExplored(board, r, c);
      this.fogVeils[i].visible = fog && isExplored(board, r, c) && !isVisible(board, r, c);
    });
    for (const child of this.levelGroup.children) {
      const tile = child.userData.tile;
      if (!tile) continue;
      const [r, c] = tile;
      child.visible = !fog || isExplored(board, r, c);
    }
    for (const entry of this.monsters.values()) {
      const m = entry.monster;
      entry.group.visible = !fog || isVisible(board, m.r, m.c) || entry.forceVisible === true;
    }
  }

  buildMarkMaterials() {
    const make = ({ fill = null, stroke, width = 8, dashed = false, inset = 6 }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      const ctx = canvas.getContext("2d");
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(inset, inset, 128 - inset * 2, 128 - inset * 2);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.lineJoin = "miter";
      if (dashed) ctx.setLineDash([16, 12]);
      const o = inset + width / 2;
      ctx.strokeRect(o, o, 128 - o * 2, 128 - o * 2);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
    };
    const ikb = "rgb(0, 47, 167)";
    return {
      move: make({ fill: "rgba(0, 47, 167, 0.14)", stroke: ikb, width: 6 }),
      path: make({ stroke: ikb, width: 5, dashed: true }),
      attack: make({ fill: "rgba(0, 47, 167, 0.55)", stroke: ikb, width: 10 }),
      threat: make({ fill: "rgba(10, 10, 10, 0.12)", stroke: "rgb(10, 10, 10)", width: 5, dashed: true }),
      hover: make({ stroke: "rgb(10, 10, 10)", width: 6 }),
      blocked: make({ stroke: "rgba(10, 10, 10, 0.4)", width: 4, dashed: true }),
    };
  }

  buildHeartSprite() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    drawPixelHeart(ctx, 4, 8, 8, "#e0262f");
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    this.heartMaterial = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    // 粒子：IKB 小方块（瑞士风里不用发光的暖色火花）。
    const spark = document.createElement("canvas");
    spark.width = spark.height = 16;
    const sctx = spark.getContext("2d");
    sctx.fillStyle = "#002fa7";
    sctx.fillRect(0, 0, 16, 16);
    const stex = new THREE.CanvasTexture(spark);
    stex.colorSpace = THREE.SRGBColorSpace;
    this.sparkMaterial = new THREE.SpriteMaterial({ map: stex, depthWrite: false, toneMapped: false });
    // 墨色碎块：首领倒下与重新站起时飞散 / 聚拢的墨黑小方块。
    const ink = document.createElement("canvas");
    ink.width = ink.height = 16;
    const ictx = ink.getContext("2d");
    ictx.fillStyle = "#141414";
    ictx.fillRect(0, 0, 16, 16);
    const itex = new THREE.CanvasTexture(ink);
    itex.colorSpace = THREE.SRGBColorSpace;
    this.inkMaterial = new THREE.SpriteMaterial({ map: itex, depthWrite: false, toneMapped: false });
  }

  // ——— 关卡构建 ———

  clearLevel() {
    this.levelGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isSprite && o.material.map && o.userData.ownTexture) o.material.map.dispose();
    });
    this.levelGroup.clear();
    this.monsters.clear();
    this.items.clear();
    this.doors.clear();
    // 直接完成而不是丢弃未结束的补间，避免等待它们的流程永远挂起。
    for (const tw of this.tweens) tw.resolve();
    this.tweens = [];
    for (const p of this.particles) this.scene.remove(p.sprite);
    this.particles = [];
    this.setMarks(new Map());
  }

  /**
   * 向四周延伸的地面：一张和格子同色、同样格线的大平面，铺在棋盘一圈之外，从大厅边缘往外逐渐淡出。
   * 格线落在整数坐标上，和棋盘的格子严丝合缝；center 是大厅中线的 x 坐标。
   */
  buildExtension(center) {
    const UNITS = 40;
    const PX = 40;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = UNITS * PX;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f4f3ef";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#bdbcb6";
    ctx.lineWidth = 1.6;
    for (let i = 0; i <= UNITS; i += 1) {
      ctx.beginPath();
      ctx.moveTo(i * PX, 0);
      ctx.lineTo(i * PX, canvas.height);
      ctx.moveTo(0, i * PX);
      ctx.lineTo(canvas.width, i * PX);
      ctx.stroke();
    }
    // 从大厅中心往外淡出：大厅范围内不透明，之后逐渐透明。
    const fade = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 5 * PX, canvas.width / 2, canvas.height / 2, 19 * PX);
    fade.addColorStop(0, "rgba(0, 0, 0, 1)");
    fade.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(UNITS, UNITS),
      new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.9, metalness: 0, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    // 平面的中心要落在格线上（整数坐标），大厅中线在半格处时往旁边挪半格。
    floor.position.set(Math.round(center), SURFACE - 0.002, 0);
    floor.receiveShadow = true;
    return floor;
  }

  /**
   * 棋盘的显示样式（只改外观，不改格子数据）：
   *   plain：不用黑白相间的棋格，改成一色的普通格子加细格线，也不标坐标；
   *   cols：只显示前几列（其余列整列是墙，玩家走不到），底板和外框收窄到这几列，镜头对准它们的中线。
   */
  applyDisplay(display = {}) {
    const cols = display.cols ?? SIZE;
    const plain = Boolean(display.plain);
    const shift = -(SIZE - cols) / 2;
    for (const tile of this.tiles) {
      const { r, c } = tile.userData;
      tile.visible = c < cols;
      tile.material = plain ? this.tileMats.plain : (r + c) % 2 === 0 ? this.tileMats.light : this.tileMats.dark;
    }
    this.boardFrame.scale.x = cols / SIZE;
    this.boardFrame.position.x = shift;
    // 普通格子样式不要棋盘四周的边框：去掉两圈黑线，底板收到和格子一样大，没有外沿。
    for (const child of this.boardFrame.children) if (child !== this.boardSlab) child.visible = !plain;
    const edge = plain ? SIZE / 9.2 : 1;
    this.boardSlab.scale.set(edge, 1, edge);
    // 普通格子样式不要底板：四周铺一圈同样的格子，越远越淡，看起来大厅一直往外延伸。
    this.boardSlab.visible = !plain;
    if (this.extension) {
      this.boardGroup.remove(this.extension);
      this.extension.geometry.dispose();
      this.extension.material.map.dispose();
      this.extension.material.dispose();
      this.extension = null;
    }
    if (plain) {
      this.extension = this.buildExtension(shift);
      this.boardGroup.add(this.extension);
    }
    for (const label of this.boardLabels) label.visible = !plain;
    if (this.plainGrid) {
      this.boardGroup.remove(this.plainGrid);
      this.plainGrid.traverse((o) => o.geometry?.dispose());
      this.plainGrid = null;
    }
    if (plain) {
      const grid = new THREE.Group();
      const lineMat = new THREE.MeshBasicMaterial({ color: "#c6c5c0" });
      const left = tileCenter(0, 0).x - 0.5;
      const top = tileCenter(0, 0).z - 0.5;
      for (let c = 1; c < cols; c += 1) {
        const line = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.006, SIZE), lineMat);
        line.position.set(left + c, SURFACE + 0.001, 0);
        grid.add(line);
      }
      for (let r = 1; r < SIZE; r += 1) {
        const line = new THREE.Mesh(new THREE.BoxGeometry(cols, 0.006, 0.02), lineMat);
        line.position.set(left + cols / 2, SURFACE + 0.001, top + r);
        grid.add(line);
      }
      this.boardGroup.add(grid);
      this.plainGrid = grid;
    }
    this.visibleCols = cols;
    // 镜头对准显示出来的这几列的中线（resize 里按它重新算默认视角）。
    this.displayShift = shift;
    this.resize();
  }

  loadLevel(board) {
    this.clearLevel();
    this.applyDisplay(board.level.display);
    const rand = seeded(board.level.id * 97);
    board.tiles.forEach((row, r) =>
      row.forEach((tile, c) => {
        // 不显示的列：整列是墙，墙也不画。
        if (!tile.prop || c >= this.visibleCols) return;
        const prop = makeProp(tile.prop, rand);
        prop.position.copy(tileCenter(r, c));
        prop.userData.tile = [r, c];
        this.levelGroup.add(prop);
      }),
    );
    for (const item of board.items.values()) {
      const model = (ITEM_MODELS[item.type] ?? makeKey)();
      model.position.copy(tileCenter(item.r, item.c));
      model.userData.type = item.type;
      model.userData.tile = [item.r, item.c];
      this.levelGroup.add(model);
      this.items.set(key(item.r, item.c), model);
      // 重玩旧章节时：已经拿过的宝箱直接敞着，用过的铁砧收起箭头。
      if (item.opened) this.showUsed(item);
    }
    for (const k of board.doors) {
      const [r, c] = k.split(",").map(Number);
      const door = makeDoor();
      door.position.copy(tileCenter(r, c));
      const walled = (rr, cc) => !board.tiles[rr]?.[cc] || board.tiles[rr][cc].prop;
      // 门挡在通道上：左右是墙时横放，上下是墙时竖放。
      door.rotation.y = walled(r, c - 1) || walled(r, c + 1) ? 0 : Math.PI / 2;
      door.userData.tile = [r, c];
      this.levelGroup.add(door);
      this.doors.set(k, door);
    }
    for (const [r, c] of board.level.carpet ?? []) {
      const carpet = makeCarpet();
      carpet.position.copy(tileCenter(r, c));
      this.levelGroup.add(carpet);
    }
    this.exit = makeExit();
    this.exit.position.copy(tileCenter(board.exit.r, board.exit.c));
    this.levelGroup.add(this.exit);
    this.setExitOpen(board.exitOpen, false);

    this.hero = makeHero();
    this.hero.position.copy(tileCenter(board.hero.r, board.hero.c));
    this.hero.rotation.y = Math.PI;
    this.levelGroup.add(this.hero);
    this.faceToward(this.hero, tileCenter(board.hero.r - 1, board.hero.c), true);

    for (const m of board.monsters) {
      const group = makeMonster(m.def.model);
      group.position.copy(tileCenter(m.r, m.c));
      const label = new LabelSprite();
      label.setScale(this.labelScale ?? 1);
      label.sprite.position.y = m.def.boss ? 1.75 : m.def.model === "ink" ? 0.85 : 1.35;
      label.sprite.userData.ownTexture = true;
      group.add(label.sprite);
      this.levelGroup.add(group);
      const entry = { group, label, monster: m, phase: rand() * 6 };
      this.monsters.set(m.uid, entry);
      this.faceToward(group, this.hero.position, true);
      this.updateMonster(m);
    }
    this.updateFog(board);
    this.resetView();
  }

  updateMonster(m) {
    const entry = this.monsters.get(m.uid);
    if (!entry) return;
    const { hearts, slots, armor } = countHearts(m.matrix);
    // Boss 的红心数量不公开。
    if (m.def.boss) entry.label.draw({ hearts: "?", total: "?", armor: 0, alert: false, stun: false });
    else entry.label.draw({ hearts, total: slots, armor, alert: m.aggro && m.stun === 0, stun: m.stun > 0 });
  }

  setExitOpen(open, animate = true) {
    const { beam, disc, seal, sealRing, light } = this.exit.userData;
    beam.visible = open;
    disc.visible = open;
    light.intensity = open ? 2.2 : 0.4;
    light.color.set(open ? "#ffd27a" : "#8a4dff");
    seal.visible = !open;
    sealRing.visible = !open;
    if (open && animate) {
      beam.scale.y = 0.01;
      this.tween(900, (t) => (beam.scale.y = t), ease.out);
      this.burst(this.exit.position.clone().setY(0.4), 26, this.sparkMaterial, 1.4);
    }
  }

  // ——— 高亮与拾取 ———

  /** marks: Map<"r,c", 类型>；未列出的格子隐藏。 */
  setMarks(marks) {
    this.overlays.forEach((overlay, index) => {
      const r = Math.floor(index / SIZE);
      const c = index % SIZE;
      const type = marks.get(key(r, c));
      overlay.visible = Boolean(type);
      if (type) overlay.material = this.markMaterials[type];
    });
  }

  bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    const pick = (event) => {
      const rect = el.getBoundingClientRect();
      this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      // 只拾取显示中的迷雾块：隐藏的迷雾块很高，不过滤会挡住后面格子的点击。
      const targets = (this.pickTargets ?? this.tiles).filter((o) => o.visible);
      const hit = this.raycaster.intersectObjects(targets, false)[0];
      return hit ? hit.object.userData : null;
    };
    el.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerup", (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 6) return;
      const tile = pick(e);
      if (tile) this.handlers.click(tile.r, tile.c);
    });
    el.addEventListener("pointermove", (e) => {
      const tile = pick(e);
      this.handlers.hover(tile ? tile.r : null, tile ? tile.c : null, e);
    });
    el.addEventListener("pointerleave", () => this.handlers.hover(null, null));
  }

  /** 屏幕上的“上/右”对应棋盘上的哪个方向（随镜头旋转自动适配）。 */
  screenDirections() {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const snap = (x, z) => (Math.abs(z) >= Math.abs(x) ? { dr: Math.sign(z), dc: 0 } : { dr: 0, dc: Math.sign(x) });
    return { up: snap(forward.x, forward.z), right: snap(-forward.z, forward.x) };
  }

  // ——— 动画 ———

  tween(duration, update, easing = ease.inOut) {
    if (this.reducedMotion) duration = Math.min(duration, 120);
    // 页面不可见时浏览器会暂停渲染循环；直接完成动画，避免回合流程挂起。
    if (document.hidden) {
      update(1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.tweens.push({ t: 0, duration, update, easing, resolve });
    });
  }

  wait(ms) {
    return this.tween(ms, () => {});
  }

  faceToward(object, target, instant = false) {
    const dx = target.x - object.position.x;
    const dz = target.z - object.position.z;
    if (Math.abs(dx) + Math.abs(dz) < 0.001) return Promise.resolve();
    const goal = Math.atan2(dx, dz);
    if (instant) {
      object.rotation.y = goal;
      return Promise.resolve();
    }
    const start = object.rotation.y;
    let delta = ((goal - start + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return this.tween(160, (t) => (object.rotation.y = start + delta * t));
  }

  async hop(object, to, height = 0.35, duration = 260) {
    const from = object.position.clone();
    this.faceToward(object, to);
    await this.tween(duration, (t) => {
      object.position.lerpVectors(from, to, t);
      object.position.y = to.y + Math.sin(Math.PI * t) * height;
    });
    const body = object.userData.body;
    if (body)
      await this.tween(120, (t) => {
        const s = Math.sin(Math.PI * t) * 0.12;
        body.scale.set(1 + s, 1 - s, 1 + s);
      });
  }

  moveHero(to) {
    return this.hop(this.hero, tileCenter(to.r, to.c));
  }

  bump(dir) {
    const start = this.hero.position.clone();
    const offset = new THREE.Vector3(dir.dc * 0.18, 0, dir.dr * 0.18);
    return this.tween(180, (t) => this.hero.position.copy(start).addScaledVector(offset, Math.sin(Math.PI * t)));
  }

  moveMonster(m, to) {
    const entry = this.monsters.get(m.uid);
    if (!entry) return Promise.resolve();
    const knight = m.def.moves === "knight";
    return this.hop(entry.group, tileCenter(to.r, to.c), knight ? 0.9 : 0.3, knight ? 420 : 280);
  }

  async lunge(object, target) {
    const start = object.position.clone();
    const dir = target.clone().sub(start).setY(0).normalize();
    await this.faceToward(object, target);
    await this.tween(140, (t) => object.position.copy(start).addScaledVector(dir, t * 0.32).setY(start.y + Math.sin(t * Math.PI) * 0.12), ease.out);
    await this.tween(200, (t) => object.position.copy(start).addScaledVector(dir, (1 - t) * 0.32));
  }

  shake(object, strength = 0.07) {
    const body = object.userData.body ?? object;
    return this.tween(320, (t) => {
      const k = (1 - t) * strength;
      body.rotation.z = Math.sin(t * 40) * k * 2;
      body.position.x = Math.sin(t * 55) * k;
    });
  }

  entityOf(side, monster) {
    return side === "hero" ? this.hero : this.monsters.get(monster.uid)?.group;
  }

  async attackAnim(attacker, target, hearts) {
    await this.lunge(attacker, target.position);
    if (hearts > 0) {
      this.burst(target.position.clone().setY(0.7), Math.min(4 + hearts * 3, 30), this.heartMaterial, 1);
      this.shake(target);
    }
  }

  burst(origin, count, material, spread = 1) {
    for (let i = 0; i < count; i += 1) {
      const sprite = new THREE.Sprite(material);
      const s = 0.12 + Math.random() * 0.1;
      sprite.scale.set(s, s, s);
      sprite.position.copy(origin);
      const a = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3(Math.cos(a) * spread, 1.2 + Math.random() * 1.6, Math.sin(a) * spread).multiplyScalar(0.9 + Math.random());
      this.scene.add(sprite);
      this.particles.push({ sprite, v, life: 0, max: 0.8 + Math.random() * 0.4, base: s });
    }
  }

  /**
   * 首领倒下：棋子朝一侧轰然倒地，溅起一片墨色碎块。
   * 转的是整个棋子（group），不是身体：受击晃动只动身体，结束时会把身体的倾斜归零。
   */
  async toppleBoss(group) {
    const start = group.rotation.z;
    await this.tween(
      620,
      (t) => {
        group.rotation.z = start + t * 1.42;
      },
      (t) => t * t * t,
    );
    this.burst(group.position.clone().setY(0.25), 26, this.inkMaterial, 1.3);
    this.shake(group, 0.05);
  }

  /** 首领重新站起：慢慢立起来，停在微微倾斜的角度（王冠歪着），墨色碎块往上涌。 */
  async raiseBoss(group, tilt = 0.2) {
    const start = group.rotation.z;
    const rising = setInterval(() => this.burst(group.position.clone().setY(0.1), 5, this.inkMaterial, 0.5), 220);
    await this.tween(2100, (t) => {
      group.rotation.z = start + (tilt - start) * t;
    }, ease.out);
    clearInterval(rising);
    this.burst(group.position.clone().setY(1.2), 30, this.inkMaterial, 1.1);
  }

  /** 首领认输：像棋手认输时那样，把王慢慢放倒。 */
  async resignBoss(group) {
    const start = group.rotation.z;
    await this.tween(1700, (t) => {
      group.rotation.z = start + (1.45 - start) * t;
    });
    this.burst(group.position.clone().setY(0.2), 18, this.inkMaterial, 0.8);
  }

  /** 墨迹退去：从离出口最远的一排开始，每一格冒出墨色碎块，一排排收向出口，最后出口处一片蓝色碎块。 */
  async recedeInk(exit) {
    for (let r = SIZE - 1; r >= 0; r -= 1) {
      for (let c = 0; c < (this.visibleCols ?? SIZE); c += 1) this.burst(tileCenter(r, c).setY(0.12), 2, this.inkMaterial, 0.25);
      await new Promise((done) => setTimeout(done, 140));
    }
    if (exit) this.burst(tileCenter(exit.r, exit.c).setY(0.4), 30, this.sparkMaterial, 1.2);
  }

  /** 入殿运镜：镜头贴着长毯从起点往王座推过去，在王座前停一拍，再回到平常的视角。 */
  async processional(from, to) {
    const a = tileCenter(from.r, from.c);
    const b = tileCenter(to.r, to.c);
    const look = b.clone().setY(0.9);
    this.controls.enabled = false;
    this.camera.position.copy(a.clone().add(new THREE.Vector3(0, 0.75, 1.9)));
    this.controls.target.copy(look);
    this.controls.update();
    await this.moveCamera(b.clone().add(new THREE.Vector3(0, 1.3, 2.7)), look, 3600);
    await new Promise((done) => setTimeout(done, 700));
    await this.resetView(1300);
  }

  async defeatMonster(m) {
    const entry = this.monsters.get(m.uid);
    if (!entry) return;
    entry.label.sprite.visible = false;
    entry.group.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.transparent = true;
      }
    });
    const start = entry.group.rotation.x;
    this.burst(entry.group.position.clone().setY(0.5), 18, this.sparkMaterial, 0.8);
    await this.tween(520, (t) => {
      entry.group.rotation.x = start - t * (Math.PI / 2.2);
      entry.group.position.y = SURFACE + Math.sin(t * Math.PI) * 0.25;
    }, ease.out);
    await this.tween(420, (t) => {
      entry.group.traverse((o) => {
        if (o.isMesh) o.material.opacity = 1 - t;
      });
      entry.group.position.y = SURFACE - t * 0.2;
    });
    this.levelGroup.remove(entry.group);
    this.monsters.delete(m.uid);
  }

  /** 不播动画地把宝箱摆成打开状态、把铁砧摆成用过的状态。 */
  showUsed(item) {
    const model = this.items.get(key(item.r, item.c));
    if (!model) return;
    this.items.delete(key(item.r, item.c));
    model.userData.badge?.removeFromParent();
    model.userData.marker?.removeFromParent();
    model.getObjectByName("pickup-marker")?.removeFromParent();
    if (model.userData.lid) model.userData.lid.rotation.x = -1.3;
  }

  /** 铁砧用过之后：收起箭头和角标，铁砧留在原地。 */
  useForge(r, c) {
    const model = this.items.get(key(r, c));
    if (!model) return;
    this.items.delete(key(r, c));
    this.burst(model.position.clone().setY(0.6), 18, this.sparkMaterial, 0.6);
    model.userData.badge?.removeFromParent();
    model.userData.marker?.removeFromParent();
  }

  async collectItem(r, c) {
    const model = this.items.get(key(r, c));
    if (!model) return;
    this.items.delete(key(r, c));
    if (model.userData.type === "chest") {
      const { lid, glow } = model.userData;
      model.getObjectByName("pickup-marker")?.removeFromParent();
      this.burst(model.position.clone().setY(0.5), 24, this.sparkMaterial, 0.7);
      await this.tween(420, (t) => {
        // 箱盖绕后沿翻开约 75°：再往后会让拱形箱盖插进箱体。
        lid.rotation.x = -t * 1.3;
        glow.intensity = t * 3;
      }, ease.out);
      // 拿走武器之后，宝箱缩小消失，这一格空出来。
      const start = model.position.clone();
      await this.tween(320, (t) => {
        model.position.y = start.y + t * 0.3;
        model.scale.setScalar(1 - t);
        glow.intensity = 3 * (1 - t);
      });
      this.levelGroup.remove(model);
      return;
    }
    const start = model.position.clone();
    this.burst(start.clone().setY(0.4), 14, model.userData.type === "potion" ? this.heartMaterial : this.sparkMaterial, 0.5);
    await this.tween(360, (t) => {
      model.position.y = start.y + t * 0.9;
      model.scale.setScalar(1 - t);
    });
    this.levelGroup.remove(model);
  }

  async openDoor(r, c) {
    const door = this.doors.get(key(r, c));
    if (!door) return;
    this.doors.delete(key(r, c));
    await this.tween(500, (t) => {
      door.position.y = -t * 0.95;
    });
    this.levelGroup.remove(door);
  }

  /** 战斗时把镜头推近到主角与怪物之间。 */
  focusOn(a, b) {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a).setY(0).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const camDir = this.camera.position.clone().sub(this.controls.target).setY(0).normalize();
    if (side.dot(camDir) < 0) side.negate();
    const pos = mid.clone().addScaledVector(side, 4.2).setY(3.4);
    return this.moveCamera(pos, mid.clone().setY(0.45), 700);
  }

  resetView(duration = 0) {
    const pos = this.homeView.pos.clone();
    const target = this.homeView.target.clone();
    if (!duration) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      return Promise.resolve();
    }
    return this.moveCamera(pos, target, duration);
  }

  restoreView(duration = 650) {
    const saved = this.savedView ?? this.homeView;
    this.savedView = null;
    return this.moveCamera(saved.pos.clone(), saved.target.clone(), duration);
  }

  saveView() {
    this.savedView = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
  }

  moveCamera(pos, target, duration) {
    const fromPos = this.camera.position.clone();
    const fromTarget = this.controls.target.clone();
    this.controls.enabled = false;
    return this.tween(duration, (t) => {
      this.camera.position.lerpVectors(fromPos, pos, t);
      this.controls.target.lerpVectors(fromTarget, target, t);
      if (t >= 1) this.controls.enabled = true;
    });
  }

  rotateView() {
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const from = Math.atan2(offset.x, offset.z);
    const radius = Math.hypot(offset.x, offset.z);
    this.controls.enabled = false;
    return this.tween(520, (t) => {
      const a = from + (Math.PI / 2) * t;
      this.camera.position.set(target.x + Math.sin(a) * radius, this.camera.position.y, target.z + Math.cos(a) * radius);
      if (t >= 1) this.controls.enabled = true;
    });
  }

  // ——— 主循环 ———

  /** 按画面宽度比例水平平移渲染结果（标题页把棋盘让到封面右侧）。 */
  setScreenShift(ratio) {
    this.screenShift = ratio;
    this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    const shift = w > 900 ? (this.screenShift ?? 0) : 0;
    if (shift) this.camera.setViewOffset(w, h, -w * shift, 0, w, h);
    else this.camera.clearViewOffset();
    // 手机屏幕小、像素密度高（iPhone 为 3 倍）：按实际密度渲染才清晰；大屏幕仍以 2 倍封顶，避免显卡压力过大。
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, w * h < 600000 ? 3 : 2));
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    const portrait = aspect < 0.9;
    this.camera.aspect = aspect;
    this.camera.fov = portrait ? 46 : 38;
    // 竖屏时棋盘整体偏小，怪物头顶的血量铭牌放大 1.5 倍。
    this.labelScale = portrait ? 1.5 : 1;
    for (const entry of this.monsters?.values() ?? []) entry.label.setScale(this.labelScale);
    this.camera.updateProjectionMatrix();
    // 按水平视角算出能装下整张棋盘（含边框）的距离；竖屏时更俯视一些。
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const hHalf = Math.atan(Math.tan(halfFov) * aspect);
    const view = portrait ? HOME_VIEW.portrait : HOME_VIEW.landscape;
    const dir = homeDirection(view);
    const dist = Math.max(view.minDistance, view.fitHalfWidth / Math.tan(hHalf));
    // 竖屏（手机）时镜头对准棋盘正中心，棋盘落在屏幕中央；上方信息栏和下方方向键各占一边，不会压住棋盘。
    const target = new THREE.Vector3(this.displayShift ?? 0, 0, portrait ? 0 : 0.3);
    this.homeView = { pos: target.clone().addScaledVector(dir.normalize(), dist), target };
    this.controls.maxDistance = Math.max(20, dist * 1.25);
    // 标题页只剩半屏给棋盘，镜头拉远一些让整张棋盘入镜。
    if (shift) this.homeView.pos.sub(target).multiplyScalar(1.4).add(target);
    if (!this.savedView && this.controls.enabled) this.resetView();
  }

  frame(timestamp) {
    this.timer.update(timestamp);
    const dt = Math.min(this.timer.getDelta(), 0.05);
    const time = this.timer.getElapsed();
    this.tweens = this.tweens.filter((tw) => {
      tw.t += dt * 1000;
      const p = Math.min(1, tw.t / tw.duration);
      tw.update(tw.easing(p));
      if (p >= 1) {
        tw.resolve();
        return false;
      }
      return true;
    });
    this.particles = this.particles.filter((p) => {
      p.life += dt;
      p.v.y -= 4.2 * dt;
      p.sprite.position.addScaledVector(p.v, dt);
      const k = 1 - p.life / p.max;
      p.sprite.scale.setScalar(p.base * Math.max(k, 0.01));
      if (p.life >= p.max) {
        this.scene.remove(p.sprite);
        return false;
      }
      return true;
    });
    if (!this.reducedMotion) this.idle(time);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    for (const hook of this.frameHooks) hook();
  }

  /** 每帧画完后调用 hook；返回取消函数。 */
  onFrame(hook) {
    this.frameHooks.add(hook);
    return () => this.frameHooks.delete(hook);
  }

  /** 怪物头顶血量铭牌在页面上的位置（px）；怪物不存在、被迷雾藏起或在镜头背后时返回 null。 */
  monsterScreenPoint(uid) {
    const entry = this.monsters.get(uid);
    if (!entry || !entry.group.visible) return null;
    const p = entry.label.sprite.getWorldPosition(new THREE.Vector3()).project(this.camera);
    if (p.z > 1) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  idle(time) {
    if (this.hero?.userData.body) this.hero.userData.body.position.y = Math.sin(time * 2.2) * 0.015;
    for (const entry of this.monsters.values()) {
      const body = entry.group.userData.body;
      body.rotation.y = Math.sin(time * 1.3 + entry.phase) * 0.08;
      if (entry.monster.def.model === "ink") body.scale.y = 1 + Math.sin(time * 3 + entry.phase) * 0.04;
      const aura = entry.group.userData.aura;
      if (aura) aura.material.opacity = 0.25 + Math.sin(time * 2) * 0.12;
    }
    for (const model of this.items.values()) {
      const spin = model.userData.spin;
      if (spin) {
        spin.rotation.y = time * 1.4;
        spin.position.y = (spin.userData.baseY ?? 0) + Math.sin(time * 2.5) * 0.04;
      }
      const bob = model.userData.bob;
      if (bob) bob.position.y = (bob.userData.baseY ?? 0) + Math.sin(time * 2.5 + 1) * 0.025;
    }
  }
}

export { MATERIALS };
