import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { HEART_PIXELS, HEART_HIGHLIGHT, HEART_W, HEART_H } from "../pixelHeart.js";

/**
 * 程序化模型，与界面同一套瑞士风色彩：
 * 棋子是车削轮廓的漆面棋具（主角 IKB 釉面，怪物黑漆），障碍是统一的灰色长方体，
 * IKB 也用于“你的东西”（钥匙、宝箱盖、出口），红色只属于红心（药水）。
 * 约定：一个棋格边长 1，模型原点在格子表面中心，+Z 为正面。
 */
const matte = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0, ...extra });

export const MATERIALS = {
  ikb: matte("#002fa7"),
  ink: matte("#141414", { roughness: 0.6 }),
  paper: matte("#fafaf8"),
  grey1: matte("#9a9995"),
  grey2: matte("#85847f"),
  grey3: matte("#6f6e6a"),
  heart: matte("#e0262f", { roughness: 0.5 }),
};

function mesh(geometry, material, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

const box = (w, h, d, material, y = h / 2) => {
  const m = mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.y = y;
  return m;
};

// ——— 棋子：旋转体车削轮廓 + 细白线装饰，像一套设计师棋具 ———

const PIECE = {
  lacquer: new THREE.MeshPhysicalMaterial({
    color: "#161616",
    roughness: 0.32,
    metalness: 0,
    clearcoat: 0.9,
    clearcoatRoughness: 0.18,
  }),
  glaze: new THREE.MeshPhysicalMaterial({
    color: "#002fa7",
    roughness: 0.34,
    metalness: 0,
    clearcoat: 0.8,
    clearcoatRoughness: 0.2,
  }),
  porcelain: new THREE.MeshPhysicalMaterial({ color: "#f6f6f2", roughness: 0.3, clearcoat: 0.6 }),
  steel: new THREE.MeshStandardMaterial({ color: "#d9dde2", metalness: 0.85, roughness: 0.25 }),
  };

/**
 * 用简单指令描出车削轮廓：["L", r, y] 直线到点，["Q", cr, cy, r, y] 二次曲线到点。
 * 曲线段细分成多个点，让棋子的腰线和领口圆润。
 */
function profile(commands) {
  const pts = [new THREE.Vector2(0, 0)];
  let last = pts[0];
  for (const cmd of commands) {
    if (cmd[0] === "L") {
      last = new THREE.Vector2(cmd[1], cmd[2]);
      pts.push(last);
    } else {
      const curve = new THREE.QuadraticBezierCurve(
        last,
        new THREE.Vector2(cmd[1], cmd[2]),
        new THREE.Vector2(cmd[3], cmd[4]),
      );
      const seg = curve.getPoints(12).slice(1);
      pts.push(...seg);
      last = seg[seg.length - 1];
    }
  }
  return pts;
}

/** 所有棋子共用的底座：带倒角的圆盘 + 向内收的台阶。 */
const baseProfile = (r = 0.32) => [
  ["L", r - 0.01, 0],
  ["Q", r + 0.012, 0.004, r + 0.008, 0.03],
  ["L", r, 0.058],
  ["Q", r - 0.012, 0.074, r - 0.05, 0.08],
  ["L", r - 0.06, 0.1],
  ["Q", r - 0.06, 0.126, r - 0.1, 0.138],
];

const turned = (commands, material, segments = 72) =>
  mesh(new THREE.LatheGeometry(profile(commands), segments), material);

/** 细白线：一圈极细的环，贴在棋子的某个高度上。 */
function hairline(radius, y, tube = 0.006, material = PIECE.porcelain) {
  const ring = mesh(new THREE.TorusGeometry(radius, tube, 8, 96), material, { cast: false });
  ring.rotation.x = Math.PI / 2;
  ring.position.y = y;
  return ring;
}

const rounded = (w, h, d, r, material) => mesh(new RoundedBoxGeometry(w, h, d, 4, r), material);

/** 主角：IKB 釉面小兵，白色围巾与一把短剑。 */
export function makeHero() {
  const group = new THREE.Group();
  const body = new THREE.Group();
  body.add(
    turned(
      [
        ...baseProfile(0.3),
        ["Q", 0.14, 0.2, 0.115, 0.36],
        ["L", 0.17, 0.39],
        ["Q", 0.185, 0.41, 0.17, 0.43],
        ["L", 0.1, 0.45],
        ["L", 0, 0.45],
      ],
      PIECE.glaze,
    ),
  );
  const head = mesh(new THREE.SphereGeometry(0.14, 48, 32), PIECE.glaze);
  head.position.y = 0.57;
  body.add(head, hairline(0.301, 0.058));

  // 围巾：一圈白色领巾，身后垂下一条飘带。
  const scarf = mesh(new THREE.TorusGeometry(0.135, 0.032, 16, 64), PIECE.porcelain);
  scarf.rotation.x = Math.PI / 2;
  scarf.position.y = 0.455;
  const tailPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.06, 0.45, -0.12),
    new THREE.Vector3(0.12, 0.38, -0.19),
    new THREE.Vector3(0.15, 0.27, -0.2),
  ]);
  const tail = mesh(new THREE.TubeGeometry(tailPath, 24, 0.024, 10, false), PIECE.porcelain);
  tail.scale.set(1, 1, 0.8);
  body.add(scarf, tail);

  // 短剑：钢刃 + 白色护手，斜挂在身侧。
  const sword = new THREE.Group();
  const blade = rounded(0.036, 0.34, 0.012, 0.005, PIECE.steel);
  blade.position.y = 0.2;
  const tip = mesh(new THREE.ConeGeometry(0.018, 0.05, 4), PIECE.steel);
  tip.position.y = 0.395;
  tip.rotation.y = Math.PI / 4;
  tip.scale.set(1, 1, 0.35);
  const guard = rounded(0.12, 0.022, 0.03, 0.008, PIECE.porcelain);
  const grip = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.08, 12), PIECE.glaze);
  grip.position.y = -0.05;
  const pommel = mesh(new THREE.SphereGeometry(0.022, 16, 12), PIECE.porcelain);
  pommel.position.y = -0.095;
  sword.add(blade, tip, guard, grip, pommel);
  sword.position.set(0.28, 0.28, 0.05);
  sword.rotation.z = -0.28;
  body.add(sword);

  group.add(body);
  group.userData = { body, sword, kind: "hero" };
  return group;
}

function horseHead() {
  const s = new THREE.Shape();
  s.moveTo(-0.14, 0);
  s.lineTo(0.12, 0);
  s.bezierCurveTo(0.1, 0.08, 0.1, 0.14, 0.16, 0.2);
  s.bezierCurveTo(0.24, 0.24, 0.3, 0.27, 0.3, 0.33);
  s.bezierCurveTo(0.3, 0.38, 0.26, 0.4, 0.2, 0.39);
  s.bezierCurveTo(0.14, 0.39, 0.1, 0.43, 0.07, 0.5);
  s.lineTo(0.05, 0.58);
  s.lineTo(0, 0.53);
  s.bezierCurveTo(-0.11, 0.51, -0.18, 0.4, -0.18, 0.26);
  s.bezierCurveTo(-0.18, 0.14, -0.16, 0.06, -0.14, 0);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.17,
    bevelEnabled: true,
    bevelThickness: 0.035,
    bevelSize: 0.028,
    bevelSegments: 6,
    curveSegments: 32,
  });
  geo.translate(0, 0, -0.085);
  const head = mesh(geo, PIECE.lacquer);
  head.rotation.y = -Math.PI / 2;
  return head;
}

/** 被墨迹侵蚀的黑色漆面棋子，底座与领口带细白线。 */
const MONSTER_BUILDERS = {
  ink() {
    const g = new THREE.Group();
    const drop = turned(
      [
        ["L", 0.24, 0.004],
        ["Q", 0.33, 0.02, 0.31, 0.12],
        ["Q", 0.29, 0.24, 0.17, 0.34],
        ["Q", 0.08, 0.41, 0.03, 0.47],
        ["L", 0, 0.48],
      ],
      PIECE.lacquer,
    );
    g.add(drop);
    for (const [x, z, r] of [
      [0.36, 0.1, 0.05],
      [-0.3, 0.24, 0.035],
      [-0.12, -0.36, 0.04],
    ]) {
      const bead = mesh(new THREE.SphereGeometry(r, 20, 14), PIECE.lacquer);
      bead.scale.y = 0.6;
      bead.position.set(x, r * 0.55, z);
      g.add(bead);
    }
    return g;
  },
  pawn() {
    const g = new THREE.Group();
    g.add(
      turned(
        [
          ...baseProfile(0.3),
          ["Q", 0.14, 0.2, 0.115, 0.36],
          ["L", 0.17, 0.39],
          ["Q", 0.185, 0.41, 0.17, 0.43],
          ["L", 0.1, 0.45],
          ["L", 0, 0.45],
        ],
        PIECE.lacquer,
      ),
    );
    const head = mesh(new THREE.SphereGeometry(0.135, 48, 32), PIECE.lacquer);
    head.position.y = 0.565;
    g.add(head, hairline(0.301, 0.058));
    return g;
  },
  knight() {
    const g = new THREE.Group();
    g.add(
      turned(
        [...baseProfile(0.31), ["Q", 0.18, 0.18, 0.2, 0.24], ["L", 0.2, 0.26], ["L", 0, 0.26]],
        PIECE.lacquer,
      ),
    );
    const head = horseHead();
    head.position.y = 0.24;
    g.add(head, hairline(0.311, 0.058));
    // 白色鼻带：一道细线横过马鼻。
    const band = rounded(0.26, 0.018, 0.022, 0.006, PIECE.porcelain);
    band.position.set(0, 0.585, 0.23);
    band.rotation.x = 0.35;
    g.add(band);
    // 鬃毛：沿后颈排开的几片圆角薄片。
    for (let i = 0; i < 5; i += 1) {
      const plate = rounded(0.07, 0.07, 0.06, 0.015, PIECE.lacquer);
      plate.position.set(0, 0.42 + i * 0.055, -0.17 + i * 0.022);
      plate.rotation.x = -0.35;
      g.add(plate);
    }
    // 像实体棋具一样侧身摆放，让马头的轮廓朝向镜头。
    const turnedAside = new THREE.Group();
    turnedAside.add(g);
    g.rotation.y = Math.PI / 2;
    return turnedAside;
  },
  bishop() {
    const g = new THREE.Group();
    g.add(
      turned(
        [
          ...baseProfile(0.3),
          ["Q", 0.13, 0.24, 0.1, 0.46],
          ["L", 0.16, 0.49],
          ["Q", 0.175, 0.51, 0.16, 0.53],
          ["L", 0.09, 0.55],
          ["Q", 0.18, 0.63, 0.14, 0.76],
          ["Q", 0.1, 0.86, 0.02, 0.9],
          ["L", 0, 0.9],
        ],
        PIECE.lacquer,
      ),
    );
    const finial = mesh(new THREE.SphereGeometry(0.038, 24, 16), PIECE.lacquer);
    finial.position.y = 0.93;
    // 一道斜向的细白线环绕主教帽，呼应它的斜线走法。
    const slash = hairline(0.148, 0.7, 0.007);
    slash.rotation.set(Math.PI / 2 + 0.55, 0, 0);
    g.add(finial, slash, hairline(0.301, 0.058));
    return g;
  },
  rook() {
    const g = new THREE.Group();
    g.add(
      turned(
        [
          ...baseProfile(0.33),
          ["Q", 0.2, 0.26, 0.19, 0.5],
          ["L", 0.25, 0.54],
          ["L", 0.25, 0.66],
          ["L", 0.2, 0.66],
          ["L", 0.2, 0.62],
          ["L", 0, 0.62],
        ],
        PIECE.lacquer,
      ),
    );
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const tooth = rounded(0.1, 0.09, 0.07, 0.018, PIECE.lacquer);
      tooth.position.set(Math.cos(a) * 0.222, 0.7, Math.sin(a) * 0.222);
      tooth.rotation.y = -a + Math.PI / 2;
      g.add(tooth);
    }
    g.add(hairline(0.331, 0.058), hairline(0.252, 0.55));
    return g;
  },
  queen() {
    const g = new THREE.Group();
    g.add(
      turned(
        [
          ...baseProfile(0.32),
          ["Q", 0.13, 0.32, 0.11, 0.6],
          ["L", 0.18, 0.63],
          ["Q", 0.195, 0.65, 0.18, 0.67],
          ["L", 0.12, 0.69],
          ["Q", 0.16, 0.76, 0.2, 0.84],
          ["L", 0.175, 0.85],
          ["Q", 0.1, 0.8, 0, 0.8],
        ],
        PIECE.lacquer,
      ),
    );
    for (let i = 0; i < 9; i += 1) {
      const a = (i / 9) * Math.PI * 2;
      const bead = mesh(new THREE.SphereGeometry(0.028, 16, 12), PIECE.lacquer);
      bead.position.set(Math.cos(a) * 0.19, 0.865, Math.sin(a) * 0.19);
      g.add(bead);
    }
    const orb = mesh(new THREE.SphereGeometry(0.06, 32, 20), PIECE.lacquer);
    orb.position.y = 0.87;
    const tip = mesh(new THREE.SphereGeometry(0.024, 16, 12), PIECE.porcelain);
    tip.position.y = 0.95;
    g.add(orb, tip, hairline(0.321, 0.058), hairline(0.182, 0.65));
    return g;
  },
  king() {
    const g = new THREE.Group();
    g.add(
      turned(
        [
          ...baseProfile(0.36),
          ["Q", 0.15, 0.36, 0.13, 0.72],
          ["L", 0.2, 0.75],
          ["Q", 0.215, 0.77, 0.2, 0.79],
          ["L", 0.14, 0.81],
          ["Q", 0.18, 0.9, 0.21, 0.98],
          ["L", 0.17, 0.99],
          ["Q", 0.08, 0.95, 0, 0.96],
        ],
        PIECE.lacquer,
      ),
    );
    const crossV = rounded(0.06, 0.24, 0.06, 0.014, PIECE.lacquer);
    crossV.position.y = 1.09;
    const crossH = rounded(0.19, 0.06, 0.06, 0.014, PIECE.lacquer);
    crossH.position.y = 1.13;
    g.add(crossV, crossH, hairline(0.361, 0.058), hairline(0.202, 0.77), hairline(0.19, 0.94));
    // 地面上一圈细方框，Boss 的领地。
    const aura = new THREE.Group();
    const auraMat = new THREE.MeshBasicMaterial({ color: "#141414", transparent: true, opacity: 0.6 });
    for (const [x, z, w, d] of [
      [0, -0.46, 0.96, 0.03],
      [0, 0.46, 0.96, 0.03],
      [-0.46, 0, 0.03, 0.96],
      [0.46, 0, 0.03, 0.96],
    ]) {
      const edge = mesh(new THREE.BoxGeometry(w, 0.006, d), auraMat, { cast: false });
      edge.position.set(x, 0.004, z);
      aura.add(edge);
    }
    aura.material = auraMat;
    g.add(aura);
    g.userData.aura = aura;
    g.scale.setScalar(1.06);
    return g;
  },
};

export function makeMonster(model) {
  const inner = MONSTER_BUILDERS[model]();
  const group = new THREE.Group();
  group.add(inner);
  group.userData = { body: inner, kind: "monster", aura: inner.userData.aura };
  return group;
}

// ——— 障碍：统一的灰色长方体，一眼就知道此路不通 ———

const OBSTACLE = new THREE.MeshPhysicalMaterial({
  color: "#8b8a85",
  roughness: 0.55,
  clearcoat: 0.25,
  clearcoatRoughness: 0.5,
});

/** 所有障碍都是同一种长方体，占满大半个格子；kind 只保留在关卡数据里。 */
export function makeProp() {
  const block = rounded(0.86, 0.36, 0.86, 0.025, OBSTACLE);
  block.position.y = 0.18;
  const g = new THREE.Group();
  g.add(block);
  return g;
}

// ——— 可交互道具：地面上有一圈细方框，表示“可以拾取” ———

function pickupMarker(color = "#002fa7") {
  const marker = new THREE.Group();
  marker.name = "pickup-marker";
  const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
  const len = 0.16;
  const edge = 0.36;
  // 四个直角角标，像取景框。
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const h = mesh(new THREE.BoxGeometry(len, 0.004, 0.022), mat, { cast: false, receive: false });
      h.position.set(sx * (edge - len / 2), 0.003, sz * edge);
      const v = mesh(new THREE.BoxGeometry(0.022, 0.004, len), mat, { cast: false, receive: false });
      v.position.set(sx * edge, 0.003, sz * (edge - len / 2));
      marker.add(h, v);
    }
  return marker;
}

/**
 * 宝箱与药水沿用玩家熟悉的游戏惯例，保证一眼认得出来：
 * 宝箱是木板箱体 + 金色箍带与锁；药水是装满红色药液的圆底瓶，头顶飘着一颗红心。
 */
const LOOT = {
  wood: new THREE.MeshPhysicalMaterial({ color: "#8a552a", roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
  woodDark: new THREE.MeshStandardMaterial({ color: "#5a3416", roughness: 0.7 }),
  gold: new THREE.MeshStandardMaterial({ color: "#e2b23c", metalness: 0.9, roughness: 0.28 }),
  goldShell: new THREE.MeshStandardMaterial({ color: "#e2b23c", metalness: 0.9, roughness: 0.28, side: THREE.DoubleSide }),
  inside: new THREE.MeshStandardMaterial({ color: "#2e1a0b", roughness: 0.9 }),
  keyhole: new THREE.MeshBasicMaterial({ color: "#1a1208" }),
  cork: new THREE.MeshStandardMaterial({ color: "#a8753f", roughness: 0.85 }),
  string: new THREE.MeshStandardMaterial({ color: "#d9c39a", roughness: 0.8 }),
  glass: new THREE.MeshPhysicalMaterial({
    color: "#ffffff",
    roughness: 0.04,
    transparent: true,
    opacity: 0.16,
    clearcoat: 1,
    depthWrite: false,
  }),
  potion: new THREE.MeshStandardMaterial({
    color: "#e0101e",
    emissive: "#c2000f",
    emissiveIntensity: 0.7,
    roughness: 0.25,
  }),
  shine: new THREE.MeshBasicMaterial({ color: "#ffffff" }),
};

/** 半圆柱（箱盖、箍带用），轴向沿 X，拱面朝上（θ 取 0 到 π 的一半在 +X，绕 Z 转 90° 后朝上）。 */
function halfDrum(radius, length, material, openEnded = false) {
  const geo = new THREE.CylinderGeometry(radius, radius, length, 40, 1, openEnded, 0, Math.PI);
  const m = mesh(geo, material);
  m.rotation.z = Math.PI / 2;
  return m;
}

/** 宝箱：木板箱体、拱形木盖、金色箍带与锁扣，旁边散落几枚金币。 */
export function makeChest() {
  const group = new THREE.Group();
  const w = 0.62;
  const h = 0.3;
  const d = 0.42;
  const r = d / 2;

  const body = rounded(w, h, d, 0.02, LOOT.wood);
  body.position.y = h / 2;
  group.add(body);
  // 木板接缝：两道横向深色细线绕箱体一圈。
  for (const y of [0.1, 0.2]) {
    const seam = mesh(new THREE.BoxGeometry(w + 0.004, 0.01, d + 0.004), LOOT.woodDark, { cast: false });
    seam.position.y = y;
    group.add(seam);
  }
  const rim = mesh(new THREE.BoxGeometry(w + 0.02, 0.035, d + 0.02), LOOT.gold);
  rim.position.y = h - 0.0175;
  group.add(rim);

  const lid = new THREE.Group();
  lid.position.set(0, h, -r);
  const dome = halfDrum(r, w, LOOT.wood);
  dome.position.z = r;
  // 箱盖底面用一块实心木板封住：打开后看到的是木板，而不是空心的壳。
  const lidFloor = mesh(new THREE.BoxGeometry(w, 0.014, d), LOOT.woodDark);
  lidFloor.position.set(0, 0.007, r);
  lid.add(dome, lidFloor);

  // 金色箍带：箱体竖带 + 箱盖拱带。
  for (const x of [-0.2, 0.2]) {
    const band = mesh(new THREE.BoxGeometry(0.055, h + 0.006, d + 0.012), LOOT.gold);
    band.position.set(x, h / 2, 0);
    group.add(band);
    const arc = halfDrum(r + 0.008, 0.055, LOOT.goldShell, true);
    arc.position.set(x, 0, r);
    lid.add(arc);
  }
  const lidEdge = mesh(new THREE.BoxGeometry(w + 0.02, 0.03, 0.03), LOOT.gold);
  lidEdge.position.set(0, 0.015, d);
  lid.add(lidEdge);
  group.add(lid);

  // 箱口：深色内壁 + 一小堆金币，箱盖打开后露出来。
  const opening = mesh(new THREE.BoxGeometry(w - 0.07, 0.006, d - 0.07), LOOT.inside, { cast: false });
  opening.position.y = h + 0.003;
  const pile = mesh(new THREE.SphereGeometry(0.15, 24, 12), LOOT.gold);
  pile.scale.set(1.4, 0.3, 0.9);
  pile.position.y = h + 0.004;
  group.add(opening, pile);

  // 锁扣：金色锁片 + 深色钥匙孔。
  const lock = rounded(0.12, 0.14, 0.035, 0.012, LOOT.gold);
  lock.position.set(0, h - 0.01, r + 0.02);
  const hole = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.01, 16), LOOT.keyhole, { cast: false });
  hole.rotation.x = Math.PI / 2;
  hole.position.set(0, h + 0.005, r + 0.04);
  const slot = mesh(new THREE.BoxGeometry(0.012, 0.035, 0.01), LOOT.keyhole, { cast: false });
  slot.position.set(0, h - 0.02, r + 0.04);
  group.add(lock, hole, slot);

  // 地上散落的金币。
  for (const [x, z, n] of [
    [0.34, 0.26, 3],
    [-0.36, 0.22, 1],
    [0.22, 0.34, 1],
  ]) {
    for (let i = 0; i < n; i += 1) {
      const coin = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.014, 24), LOOT.gold);
      coin.position.set(x + i * 0.006, 0.007 + i * 0.015, z);
      group.add(coin);
    }
  }

  const glow = new THREE.PointLight("#ffcf6a", 0, 2.2, 2);
  glow.position.set(0, 0.55, 0);
  group.add(glow, pickupMarker("#d9a52c"));
  group.userData = { lid, glow };
  return group;
}

/** 体素红心：按像素红心点阵摆放小方块，与界面里的像素红心同形。 */
function voxelHeart(px, material, shine = PIECE.porcelain) {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(px, px, px);
  for (const [x, y] of HEART_PIXELS) {
    const isShine = x === HEART_HIGHLIGHT[0] && y === HEART_HIGHLIGHT[1];
    const cube = mesh(geo, isShine ? shine : material);
    cube.position.set((x - (HEART_W - 1) / 2) * px, ((HEART_H - 1) / 2 - y) * px, 0);
    g.add(cube);
  }
  return g;
}

/** 红心药水：圆底长颈瓶装满红色药液，软木塞系着细绳，瓶子上方飘着一颗旋转的像素红心。 */
export function makePotion() {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  const bulb = mesh(new THREE.SphereGeometry(0.17, 40, 28), LOOT.glass);
  bulb.position.y = 0.18;
  bulb.castShadow = false;
  const liquid = mesh(new THREE.SphereGeometry(0.152, 40, 28), LOOT.potion);
  liquid.position.y = 0.175;
  const neck = mesh(new THREE.CylinderGeometry(0.05, 0.058, 0.16, 24, 1, true), LOOT.glass);
  neck.position.y = 0.39;
  neck.castShadow = false;
  const neckLiquid = mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.06, 20), LOOT.potion);
  neckLiquid.position.y = 0.335;
  const lip = mesh(new THREE.TorusGeometry(0.056, 0.014, 10, 28), LOOT.glass);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = 0.47;
  const cork = mesh(new THREE.CylinderGeometry(0.052, 0.044, 0.09, 20), LOOT.cork);
  cork.position.y = 0.5;
  const string = mesh(new THREE.TorusGeometry(0.058, 0.009, 8, 28), LOOT.string);
  string.rotation.x = Math.PI / 2;
  string.position.y = 0.43;
  // 玻璃高光：瓶身左上方一道白色小光斑。
  const shine = mesh(new THREE.SphereGeometry(0.03, 16, 12), LOOT.shine, { cast: false });
  shine.scale.set(0.6, 1.4, 0.3);
  shine.position.set(-0.085, 0.25, 0.135);
  shine.rotation.z = 0.5;
  inner.add(bulb, liquid, neck, neckLiquid, lip, cork, string, shine);
  inner.userData.baseY = 0.02;
  inner.position.y = 0.02;
  inner.scale.setScalar(1.2);

  // 头顶飘着的红心：告诉玩家“这是回复红心的东西”。
  const badge = new THREE.Group();
  badge.add(voxelHeart(0.036, LOOT.potion));
  badge.position.y = 0.86;
  badge.userData.baseY = 0.86;

  group.add(inner, badge, pickupMarker("#e0262f"));
  group.userData = { spin: badge, bob: inner };
  return group;
}

/** 钥匙：IKB 釉面的老式钥匙，环形钥匙柄 + 长杆 + 两齿钥匙头，悬浮旋转。 */
export function makeKey() {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  const bow = mesh(new THREE.TorusGeometry(0.1, 0.03, 16, 40), PIECE.glaze);
  bow.position.x = -0.2;
  const bowCore = mesh(new THREE.TorusGeometry(0.045, 0.014, 12, 28), PIECE.glaze);
  bowCore.position.x = -0.2;
  const collar = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 20), PIECE.glaze);
  collar.rotation.z = Math.PI / 2;
  collar.position.x = -0.08;
  const shaft = mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.32, 16), PIECE.glaze);
  shaft.rotation.z = Math.PI / 2;
  shaft.position.x = 0.1;
  const toothA = rounded(0.045, 0.1, 0.03, 0.008, PIECE.glaze);
  toothA.position.set(0.23, -0.06, 0);
  const toothB = rounded(0.045, 0.07, 0.03, 0.008, PIECE.glaze);
  toothB.position.set(0.15, -0.045, 0);
  inner.add(bow, bowCore, collar, shaft, toothA, toothB);
  inner.position.y = 0.42;
  inner.userData.baseY = 0.42;
  inner.rotation.z = 0.12;
  group.add(inner, pickupMarker());
  group.userData = { spin: inner };
  return group;
}

/**
 * 护甲片：一块墨黑漆面的方牌，上面凸起 2×2 排列的四块小方甲，悬浮旋转。
 * 2×2 的排列正好对应它在红心矩阵上覆盖的范围，看模型就知道拾取后能护住哪一片。
 */
export function makePlate() {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  const base = rounded(0.34, 0.34, 0.05, 0.012, PIECE.lacquer);
  inner.add(base);
  const size = 0.13;
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const scale = rounded(size, size, 0.05, 0.01, PIECE.steel);
    scale.position.set(x * 0.075, y * 0.075, 0.045);
    inner.add(scale);
  }
  // 方牌立起来，微微后仰，正面朝向镜头一侧。
  inner.rotation.x = -0.35;
  inner.position.y = 0.42;
  inner.userData.baseY = 0.42;
  group.add(inner, pickupMarker());
  group.userData = { spin: inner };
  return group;
}

/** 铁栅门：墨黑细栅。 */
export function makeDoor() {
  const group = new THREE.Group();
  group.add(box(0.9, 0.05, 0.06, MATERIALS.ink, 0.72));
  for (let i = 0; i < 7; i += 1) {
    const bar = box(0.04, 0.72, 0.04, MATERIALS.ink);
    bar.position.x = -0.42 + i * 0.14;
    group.add(bar);
  }
  return group;
}

/**
 * 墨印：一块低矮的墨黑方石挡在路上，顶面一个白色叉号（和封住的出口同一个记号）。
 * 守卫倒下时出现裂痕（叉号变红、石块矮下去一截），守卫全部倒下后沉入地面。
 */
export function makeSeal() {
  const group = new THREE.Group();
  const stone = box(0.86, 0.34, 0.86, MATERIALS.ink);
  const mark = new THREE.Group();
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const stroke = box(0.82, 0.02, 0.07, MATERIALS.paper, 0.35);
    stroke.rotation.y = angle;
    mark.add(stroke);
  }
  group.add(stone, mark);
  group.userData = { stone, mark };
  return group;
}

/** 长毯：贴着棋盘的一块墨黑薄板，从起点铺向王座。 */
export function makeCarpet() {
  const carpet = box(0.96, 0.008, 0.96, MATERIALS.ink, 0.004);
  carpet.castShadow = false;
  return carpet;
}

/** 出口：开启时是 IKB 方板 + 直立方框；封印时是墨黑方板 + 叉号。 */
export function makeExit() {
  const group = new THREE.Group();
  const disc = box(0.84, 0.02, 0.84, MATERIALS.ikb, 0.01);
  const beam = new THREE.Group();
  const h = 1.3;
  for (const [x, z] of [
    [-0.4, -0.4],
    [0.4, -0.4],
    [-0.4, 0.4],
    [0.4, 0.4],
  ]) {
    const post = box(0.035, h, 0.035, MATERIALS.ikb);
    post.position.x = x;
    post.position.z = z;
    beam.add(post);
  }
  for (const [x, z, w, d] of [
    [0, -0.4, 0.835, 0.035],
    [0, 0.4, 0.835, 0.035],
    [-0.4, 0, 0.035, 0.835],
    [0.4, 0, 0.035, 0.835],
  ]) {
    const top = box(w, 0.035, d, MATERIALS.ikb, h);
    top.position.x = x;
    top.position.z = z;
    beam.add(top);
  }
  const seal = box(0.84, 0.02, 0.84, MATERIALS.ink, 0.012);
  const sealRing = new THREE.Group();
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const stroke = box(0.9, 0.02, 0.07, MATERIALS.paper, 0.03);
    stroke.rotation.y = angle;
    sealRing.add(stroke);
  }
  const light = new THREE.Object3D();
  light.intensity = 0;
  light.color = { set() {} };
  group.add(disc, beam, seal, sealRing, light);
  group.userData = { beam, disc, seal, sealRing, light };
  return group;
}

/** 铁砧（武器强化格）：深色铁砧放在石座上，上方悬浮一个旋转的 IKB 向上箭头，表示“强化”。 */
export function makeForge() {
  const group = new THREE.Group();
  const iron = new THREE.MeshPhysicalMaterial({ color: "#3a3d42", metalness: 0.75, roughness: 0.35, clearcoat: 0.4 });
  const stone = new THREE.MeshStandardMaterial({ color: "#9a9994", roughness: 0.8 });
  const base = rounded(0.5, 0.14, 0.4, 0.02, stone);
  base.position.y = 0.07;
  const foot = rounded(0.36, 0.06, 0.26, 0.015, iron);
  foot.position.y = 0.17;
  const waist = rounded(0.18, 0.12, 0.16, 0.015, iron);
  waist.position.y = 0.26;
  const face = rounded(0.46, 0.1, 0.22, 0.02, iron);
  face.position.y = 0.37;
  const horn = mesh(new THREE.ConeGeometry(0.08, 0.2, 24), iron);
  horn.rotation.z = Math.PI / 2;
  horn.position.set(0.32, 0.37, 0);
  horn.scale.set(1, 1, 0.8);
  // 砧面上一道 IKB 细线。
  const line = mesh(new THREE.BoxGeometry(0.4, 0.004, 0.02), MATERIALS.ikb, { cast: false });
  line.position.y = 0.423;
  group.add(base, foot, waist, face, horn, line);

  const badge = new THREE.Group();
  const chevron = new THREE.Shape();
  chevron.moveTo(0, 0.14);
  chevron.lineTo(0.13, 0);
  chevron.lineTo(0.06, 0);
  chevron.lineTo(0.06, -0.12);
  chevron.lineTo(-0.06, -0.12);
  chevron.lineTo(-0.06, 0);
  chevron.lineTo(-0.13, 0);
  chevron.closePath();
  const arrowGeo = new THREE.ExtrudeGeometry(chevron, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.008, bevelSegments: 2 });
  arrowGeo.center();
  badge.add(mesh(arrowGeo, MATERIALS.ikb));
  badge.position.y = 0.78;
  badge.userData.baseY = 0.78;
  const marker = pickupMarker();
  group.add(badge, marker);
  group.userData = { spin: badge, badge, marker };
  return group;
}
