import { parseShape } from "../logic/shapes.js";

/**
 * 主角武器。cooldown 表示使用后需要等待的己方回合数。
 * weight 决定武器的定位，强化也围绕定位来设计（见 logic/arsenal.js 的 upgradeAllowed）：
 *   light  轻武器：两格、无冷却、不花充能，灵活地“拼”进心阵的缝隙里，是连击的主力；
 *   medium 中型：三格左右，花 1 点充能，用来接住连击；
 *   heavy  重武器：一下砸一大片，花 2 点充能（开局只有 1 点，必须先连上一下），
 *          打碎 3 颗心能打断怪物蓄力后的重击。
 * 形状锚点（@）就是鼠标悬停的那一格，形状默认保持字符画里的朝向。
 * plus：“延长”后的形状；giant：重武器“巨化”后的形状；transforms：该武器可以获得的变形强化
 * （方形的战锤和对称的圣十字变形后形状不变，所以没有变形强化）。
 */
export const WEAPONS = {
  dagger: {
    id: "dagger",
    weight: "light",
    name: "短剑",
    art: ["@#"],
    plus: ["@##"],
    transforms: ["rotate"],
    cooldown: 0,
    desc: "横向攻击两格。",
  },
  slash: {
    id: "slash",
    weight: "light",
    name: "斜刃",
    art: ["@.", ".#"],
    plus: ["@..", ".#.", "..#"],
    transforms: [],
    // 斜线武器天生就能左右翻转：只有一个斜向，在空心的心阵上很难找到落点。
    innate: ["mirror"],
    cooldown: 0,
    desc: "斜向攻击两格，可以左右翻转。",
  },
  hook: {
    id: "hook",
    weight: "medium",
    name: "钩镰",
    art: ["@#", "#."],
    plus: ["@##", "#.."],
    transforms: ["rotate", "mirror"],
    cooldown: 1,
    desc: "L 形攻击三格。",
  },
  spear: {
    id: "spear",
    weight: "medium",
    name: "长枪",
    art: ["#", "@", "#"],
    plus: ["#", "@", "#", "#"],
    transforms: ["rotate"],
    cooldown: 1,
    desc: "纵向攻击三格。",
  },
  hammer: {
    id: "hammer",
    weight: "heavy",
    name: "战锤",
    // 战锤 2×2，延长后 2×3，巨化后 3×4。范围够大，但要攒够充能才能抡起来。
    art: ["@#", "##"],
    plus: ["@##", "###"],
    giant: ["@###", "####", "####"],
    transforms: [],
    cooldown: 1,
    desc: "攻击 2×2 范围，可打断重击。",
  },
  scythe: {
    id: "scythe",
    weight: "medium",
    name: "月镰",
    art: ["#..", ".@.", "..#"],
    plus: ["#...", ".@..", "..#.", "...#"],
    transforms: [],
    innate: ["mirror"],
    cooldown: 1,
    desc: "斜向攻击三格，可以左右翻转。",
  },
  awl: {
    id: "awl",
    weight: "medium",
    name: "破甲锥",
    art: ["@", "#"],
    plus: ["@", "#", "#"],
    transforms: ["rotate"],
    cooldown: 1,
    pierce: true,
    desc: "纵向攻击两格，一击消除护甲心。",
  },
  cross: {
    id: "cross",
    weight: "heavy",
    name: "圣十字",
    // 圣十字四条臂各一格，延长后各两格，巨化后各三格。
    art: [".#.", "#@#", ".#."],
    plus: ["..#..", "..#..", "##@##", "..#..", "..#.."],
    giant: ["...#...", "...#...", "...#...", "###@###", "...#...", "...#...", "...#..."],
    transforms: [],
    cooldown: 1,
    desc: "十字形攻击五格，可打断重击。",
  },
};

for (const weapon of Object.values(WEAPONS)) {
  weapon.shape = parseShape(weapon.art);
  weapon.plusShape = parseShape(weapon.plus);
  // 巨化只有重武器才有。
  weapon.giantShape = weapon.giant ? parseShape(weapon.giant) : null;
}

/** 防御与药水不是武器，但同样有形状/冷却，放在一起便于界面统一渲染。 */
export const SHIELD = {
  name: "防御",
  cooldown: 3,
  desc: "抵挡下一次攻击，不消耗回合。",
};

export const POTION = {
  name: "红心药水",
  shape: parseShape([".#.", "#@#", ".#."]),
  desc: "恢复十字范围内的红心。",
};

/** 开局只有短剑；钩镰是序章通关的奖励（见 levels.js 的 reward）。 */
export const STARTING_WEAPONS = ["dagger"];
