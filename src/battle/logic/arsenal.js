import { WEAPONS } from "../data/weapons.js";
import { SKILLS } from "../data/skills.js";
import { transformShape, shapeKey } from "./shapes.js";

/**
 * 强化种类的文字说明（界面与测试共用）。
 * tier：basic 基础强化（补短板）/ advanced 进阶强化（放大长处，稀有）。
 * desc 里的 [连击]、[追击] 是关键词标记：界面上用 rich()（ui/keywords.js）渲染成带专属图标的强调色。
 * toggle：战斗中用按钮切换的变形类强化（招式卡上不画标记，选中武器后出现对应按钮）。
 *
 * 所有强化都不改变两条核心规则：每一击必须紧挨上一击、每一格都要落在红心上。
 */
export const UPGRADE_TEXT = {
  rotate: { name: "旋转", icon: "rotate", tier: "basic", toggle: true, desc: "战斗中可将攻击形状旋转 90°。" },
  mirror: { name: "镜像", icon: "mirror", tier: "basic", toggle: true, desc: "战斗中可将攻击形状左右翻转。" },
  extend: { name: "延长", icon: "extend", tier: "basic", toggle: true, desc: "战斗中可在原形状与加长形状之间切换，不占用回合。" },
  precise: { name: "精准", icon: "energy", tier: "basic", desc: "用该武器构成[连击]时，额外获得 1 点充能。" },
  parry: { name: "招架", icon: "parry", tier: "basic", desc: "用该武器构成[连击]时，怪物下一招少打 1 颗心（每回合最多一次）。" },
  leech: { name: "吸血", icon: "leech", tier: "basic", desc: "用该武器打出[追击]时，回复 2 颗红心。" },
  pierce: { name: "破甲", icon: "pierce", tier: "basic", desc: "一击消除护甲心。" },
  stagger: { name: "震慑", icon: "stagger", tier: "basic", desc: "单次消除不少于 2 颗红心即可打断重击。" },
  chain: { name: "连锁", icon: "combo", tier: "advanced", desc: "用该武器构成[连击]时，连击数额外 +1。" },
  doom: { name: "死灭", icon: "doom", tier: "advanced", desc: "用该武器构成[连击]时，被它消除的格子从心阵上抹去，怪物无法在此恢复红心。" },
  line: { name: "贯通", icon: "line", tier: "advanced", desc: "直线形的攻击沿自身方向继续延伸，直到遇到空位为止。" },
  giant: { name: "巨化", icon: "giant", tier: "advanced", toggle: true, desc: "战斗中可切换为更大的巨化形状，与延长各用一个按钮，不占用回合。需先获得延长。" },
  quake: { name: "震地", icon: "quake", tier: "advanced", desc: "该武器打断重击时，怪物额外晕眩 1 回合。" },
};

/** 是否为进阶强化。 */
export const isAdvanced = (kind) => UPGRADE_TEXT[kind]?.tier === "advanced";

/** 武器槽与技能槽。技能不占武器槽，但最多只能携带 SKILL_SLOTS 个。 */
export const MAX_WEAPON_SLOTS = 5;
export const SKILL_SLOTS = 3;

/**
 * 形状是不是一条直线（所有格子共线且连续，至少两格）：贯通只对直线形武器开放。
 */
export function isLineShape(shape) {
  if (shape.size < 2) return false;
  const [r0, c0] = shape.cells[0];
  const [r1, c1] = shape.cells[1];
  const dr = Math.sign(r1 - r0);
  const dc = Math.sign(c1 - c0);
  return shape.cells.every(([r, c], i) => r === r0 + dr * i && c === c0 + dc * i);
}

/**
 * 武器当前的攻击形状：先看切换到了哪一档长度，再按战斗中的朝向变形。
 * orient.ext：0 原形状，1 延长后的形状，2 巨化后的形状（延长、巨化各有一个开关按钮）；界面上默认展示原形状。
 */
export function weaponShape(id, upgrades = {}, orient = {}) {
  const weapon = WEAPONS[id];
  const up = upgrades[id] ?? {};
  const ext = up.extend ? Math.min(Number(orient.ext ?? 0), up.giant && weapon.giantShape ? 2 : 1) : 0;
  const base = [weapon.shape, weapon.plusShape, weapon.giantShape][ext];
  return transformShape(base, {
    rot: up.rotate ? orient.rot ?? 0 : 0,
    flip: up.mirror ? Boolean(orient.flip) : false,
  });
}

export function skillShape(id) {
  return SKILLS[id].shape;
}

/** 战斗中实际生效的强化：在锻造得来的强化之上，补上武器天生就有的变形（斜刃、月镰天生能镜像）。 */
export function withInnate(upgrades = {}) {
  const result = { ...upgrades };
  for (const w of Object.values(WEAPONS))
    if (w.innate?.length) result[w.id] = { ...result[w.id], ...Object.fromEntries(w.innate.map((k) => [k, true])) };
  return result;
}

/** 该武器所有“看起来不同”的旋转角度（与平移无关），例如短剑只有横、竖两种。 */
export function distinctRotations(id, upgrades = {}, orient = {}) {
  const rots = [];
  const keys = new Set();
  for (let rot = 0; rot < 4; rot += 1) {
    const key = shapeKey(weaponShape(id, upgrades, { ...orient, rot }));
    if (keys.has(key)) continue;
    keys.add(key);
    rots.push(rot);
  }
  return rots;
}

/** 延长、巨化各是一个开关：按下切到这一档范围，再按一次回到原形状。level：1 延长，2 巨化。 */
export const EXTENT_LEVEL = { extend: 1, giant: 2 };

/** 按下延长或巨化按钮之后，武器切到哪一档范围（0 原形状）。 */
export function toggleExtent(kind, orient = {}) {
  const level = EXTENT_LEVEL[kind];
  return Number(orient.ext ?? 0) === level ? 0 : level;
}

/** 旋转到下一个不同的朝向，循环往复。 */
export function nextRotation(id, upgrades = {}, orient = {}) {
  const rots = distinctRotations(id, upgrades, orient);
  const index = rots.indexOf(orient.rot ?? 0);
  return rots[(index + 1) % rots.length];
}

/**
 * 每种定位能拿到的强化（旋转、镜像另看武器自己的 transforms）。
 *
 * 设计依据是怪物的心阵与两条核心规则（紧挨上一击、每格都落在红心上）：
 * 基础强化补短板，让缺点没那么明显；进阶强化放大长处，稀有，在铁砧上偶然刷出。
 *  - 轻武器：定位是“垫刀”，永远两格。基础：精准、招架、吸血（打出追击时回复红心）；进阶：连锁、死灭（构成连击时生效）。
 *  - 中型：形状特化。基础：延长（可切换）、破甲；进阶：贯通（仅直线形）。
 *  - 重武器：范围大、耗能高。基础：延长（可切换）、震慑、破甲；进阶：巨化（需先有延长）、震地。
 */
const ROLE_UPGRADES = {
  light: { basic: ["precise", "parry", "leech"], advanced: ["chain", "doom"] },
  medium: { basic: ["extend", "pierce"], advanced: ["line"] },
  heavy: { basic: ["extend", "stagger", "pierce"], advanced: ["giant", "quake"] },
};

/**
 * 某件武器能不能拿到某项强化。upgrades 为主角现有的强化（用来检查前置条件）。
 * 只在用得上的时候才刷出来：破甲要等护甲怪出场（opts.pierce 为 false 时不出），
 * 震慑、震地要等会蓄力重击的怪物出场（opts.stagger），死灭要等会回血的怪物出场（opts.heal）。
 */
export function upgradeAllowed(id, kind, opts = {}, upgrades = {}) {
  const w = WEAPONS[id];
  if (!w) return false;
  if (kind === "rotate" || kind === "mirror") return w.transforms.includes(kind);
  const role = ROLE_UPGRADES[w.weight];
  if (!role || ![...role.basic, ...role.advanced].includes(kind)) return false;
  if (kind === "pierce") return !w.pierce && opts.pierce !== false;
  if (kind === "stagger" || kind === "quake") return opts.stagger !== false;
  if (kind === "doom") return opts.heal !== false;
  if (kind === "line") return isLineShape(w.shape);
  if (kind === "giant") return Boolean(w.giantShape) && Boolean(upgrades[id]?.extend);
  return true;
}

/** 改名或被替换掉的强化：旧存档里的“垫步”换成取代它的“招架”，玩家不会白白失去一项强化。 */
const RENAMED_UPGRADES = { relay: "parry" };

/** 去掉规则调整后不再允许的强化（旧存档里可能有）；改名的强化换成新名字。 */
export function sanitizeUpgrades(upgrades = {}) {
  const clean = {};
  for (const [id, up] of Object.entries(upgrades)) {
    const renamed = Object.fromEntries(Object.entries(up).map(([kind, on]) => [RENAMED_UPGRADES[kind] ?? kind, on]));
    const kept = Object.fromEntries(Object.entries(renamed).filter(([kind, on]) => on && upgradeAllowed(id, kind, {}, upgrades)));
    if (Object.keys(kept).length) clean[id] = kept;
  }
  return clean;
}

/** 各类基础强化出现的相对概率。精准对连击的收益大，出得少一些；延长可以切换、只有好处，也略微压低。 */
const UPGRADE_WEIGHT = { rotate: 1, mirror: 1, extend: 0.8, precise: 0.5, parry: 1, leech: 1, pierce: 1, stagger: 1 };

/**
 * 进阶强化的稀有度按“整局”来控制，而不是每座铁砧各掷一次骰子：
 * 从开始到通关，一共会有 1～3 座铁砧给出进阶强化（概率 1/4、1/2、1/4，期望 2 座）。
 * 开新档时就排好“第几次使用铁砧”会出现进阶强化，存进进度里；中途退出、重开章节都不会改变。
 */
export const ADVANCED_COUNT_ODDS = [
  [1, 0.25],
  [2, 0.5],
  [3, 0.25],
];

/** 按 ADVANCED_COUNT_ODDS 抽这一局一共出现几次进阶强化。 */
function drawAdvancedCount(rng) {
  let roll = rng();
  for (const [count, p] of ADVANCED_COUNT_ODDS) {
    if (roll < p) return count;
    roll -= p;
  }
  return ADVANCED_COUNT_ODDS.at(-1)[0];
}

/**
 * 排出这一局里出现进阶强化的铁砧（按使用顺序编号，从 0 开始）。
 * 分层抽样：把还没用过的铁砧均分成 n 段，每段里随机挑一座，进阶强化不会扎堆，也不会全挤在最后。
 * @param {object} p
 * @param {number} p.total 整个游戏的铁砧总数
 * @param {number} [p.used] 已经用过的铁砧数（旧存档中途接入时用）
 * @param {number} [p.owned] 已经拥有的进阶强化数（旧存档里按旧规则拿到的，计入这一局的总数）
 * @param {() => number} rng
 * @returns {number[]} 升序的使用序号
 */
export function planAdvancedForges({ total, used = 0, owned = 0 }, rng = Math.random) {
  const remaining = Math.max(0, total - used);
  const count = Math.min(Math.max(0, drawAdvancedCount(rng) - owned), remaining);
  const plan = [];
  for (let i = 0; i < count; i += 1) {
    const from = used + Math.floor((remaining * i) / count);
    const to = used + Math.floor((remaining * (i + 1)) / count);
    plan.push(from + Math.floor(rng() * (to - from)));
  }
  return plan;
}

/** 按权重不放回地抽一个。 */
function drawWeighted(pool, rng) {
  let roll = rng() * pool.reduce((sum, o) => sum + o.w, 0);
  let i = 0;
  while (i < pool.length - 1 && roll >= pool[i].w) roll -= pool[i++].w;
  const [{ weapon, kind }] = pool.splice(i, 1);
  return { weapon, kind };
}

/** 主角现在还能拿到的强化，分成基础（basic）与进阶（rare）两堆，每项带抽取权重 w。 */
function candidatePools(hero, opts = {}) {
  const basic = [];
  const rare = [];
  for (const id of hero.weapons) {
    const up = hero.upgrades?.[id] ?? {};
    for (const kind of Object.keys(UPGRADE_TEXT)) {
      if (up[kind] || !upgradeAllowed(id, kind, opts, hero.upgrades)) continue;
      (isAdvanced(kind) ? rare : basic).push({ weapon: id, kind, w: UPGRADE_WEIGHT[kind] ?? 1 });
    }
  }
  return { basic, rare };
}

/** 主角现在还有没有能拿的进阶强化（排到进阶强化的铁砧若一项都给不出，就把这一次顺延到下一座）。 */
export const hasAdvancedOption = (hero, opts = {}) => candidatePools(hero, opts).rare.length > 0;

/**
 * 武器强化格随机给出的候选项：只从已经拿到的武器里出，已拥有的强化不再出现。
 * advanced 为 true（这一座铁砧排到了进阶强化）时，其中随机一项换成进阶强化（整组只有一个）；
 * 否则全部是基础强化。基础强化按权重抽取。
 */
export function upgradeOptions(hero, rng = Math.random, count = 3, opts = {}, { advanced = false } = {}) {
  const { basic, rare } = candidatePools(hero, opts);
  const picked = [];
  while (picked.length < count && basic.length) picked.push(drawWeighted(basic, rng));
  if (advanced && rare.length) {
    // 进阶强化放在随机一格上：组里还没满就补一格，满了就替换掉一项基础强化。
    const option = drawWeighted(rare, rng);
    if (picked.length < count) picked.splice(Math.floor(rng() * (picked.length + 1)), 0, option);
    else picked[Math.floor(rng() * count)] = option;
  }
  return picked;
}

export function applyUpgrade(hero, option) {
  hero.upgrades ??= {};
  hero.upgrades[option.weapon] = { ...(hero.upgrades[option.weapon] ?? {}), [option.kind]: true };
}

/** 强化前后的形状，用于强化选择界面的对比图。 */
export function upgradePreview(option, upgrades = {}) {
  const before = weaponShape(option.weapon, upgrades);
  const next = { ...upgrades, [option.weapon]: { ...(upgrades[option.weapon] ?? {}), [option.kind]: true } };
  const orient = { rotate: { rot: 1 }, mirror: { flip: true }, extend: { ext: 1 }, giant: { ext: 2 } }[option.kind] ?? {};
  return { before, after: weaponShape(option.weapon, next, orient) };
}

const sameOption = (a, b) => a.weapon === b.weapon && a.kind === b.kind;

/**
 * 铁砧的三项强化在第一次打开时生成并保存，之后反复打开看到的都是同一组；
 * 每一项可以单独刷新一次，所以一座铁砧最多只会出现 6 个不同的选项。
 * advanced：这一座铁砧是否排到了进阶强化（见 planAdvancedForges）。
 */
export function createForgeOptions(hero, rng = Math.random, opts = {}, { advanced = false } = {}) {
  return upgradeOptions(hero, rng, 3, opts, { advanced }).map((option) => ({ ...option, rerolled: false }));
}

/**
 * 刷新一项：基础强化只会刷成另一项基础强化，进阶强化只会刷成另一项进阶强化，
 * 所以刷新不会多出、也不会弄丢这一局排好的进阶强化。
 */
export function rerollForgeOption(hero, options, index, rng = Math.random, opts = {}) {
  const current = options[index];
  if (!current || current.rerolled) return { ok: false, reason: "每项强化仅可重抽一次" };
  const pools = candidatePools(hero, opts);
  const pool = (isAdvanced(current.kind) ? pools.rare : pools.basic).filter((o) => !options.some((x) => sameOption(x, o)));
  if (!pool.length) return { ok: false, reason: "没有其他可选的强化" };
  options[index] = { ...drawWeighted(pool, rng), rerolled: true };
  return { ok: true };
}

/**
 * 进入章节时的武器配置：优先沿用上次的配置，空位按获得顺序补齐，超出槽位的放进背包。
 */
export function defaultEquip(owned, saved = null, slots = 2) {
  const kept = (saved ?? []).filter((id) => owned.includes(id)).slice(0, slots);
  // 有存档就原样沿用；空出来的槽位留给玩家自己决定装什么。
  if (saved && kept.length) return kept;
  return owned.slice(0, slots);
}

export function toggleEquip(hero, id) {
  if (!hero.weapons.includes(id)) return { ok: false, reason: "尚未获得该武器" };
  if (hero.equipped.includes(id)) {
    if (hero.equipped.length <= 1) return { ok: false, reason: "至少需要装备一件武器" };
    hero.equipped = hero.equipped.filter((w) => w !== id);
    return { ok: true };
  }
  if (hero.equipped.length >= hero.slots) return { ok: false, reason: "武器槽已满" };
  hero.equipped = [...hero.equipped, id];
  return { ok: true };
}

export function toggleSkill(hero, id) {
  if (!(id in hero.skills)) return { ok: false, reason: "尚未习得该技能" };
  if (hero.equippedSkills.includes(id)) {
    hero.equippedSkills = hero.equippedSkills.filter((s) => s !== id);
    return { ok: true };
  }
  if (hero.equippedSkills.length >= SKILL_SLOTS) return { ok: false, reason: "技能槽已满" };
  hero.equippedSkills = [...hero.equippedSkills, id];
  return { ok: true };
}

/** 背包里的武器换下出战中的一件，保持槽位顺序。 */
export function swapEquip(hero, outId, inId) {
  const i = hero.equipped.indexOf(outId);
  if (i < 0 || !hero.weapons.includes(inId) || hero.equipped.includes(inId)) return { ok: false, reason: "无法替换" };
  hero.equipped = hero.equipped.map((id, k) => (k === i ? inId : id));
  return { ok: true };
}

export function swapSkill(hero, outId, inId) {
  const i = hero.equippedSkills.indexOf(outId);
  if (i < 0 || !(inId in hero.skills) || hero.equippedSkills.includes(inId)) return { ok: false, reason: "无法替换" };
  hero.equippedSkills = hero.equippedSkills.map((id, k) => (k === i ? inId : id));
  return { ok: true };
}

/**
 * 拖动换装：把一件武器或技能拖到“出战”或“闲置”里的某个位置。
 * @param {object} hero 主角（equipped / equippedSkills / weapons / skills / slots）
 * @param {object} move { kind: "weapon" | "skill", id, toZone: "on" | "off", targetId?: 放到哪一行上, before?: 放在那一行之前 }
 * 规则：
 *  - 出战段内拖动：调整顺序（决定快捷键）；
 *  - 闲置 → 出战：有空槽就插到放下的位置；槽满时放到某一件上 = 两件互换；
 *  - 出战 → 闲置：换下（武器至少留一件）；放到闲置的某一件上 = 两件互换。
 */
export function moveLoadout(hero, move) {
  const weapon = move.kind === "weapon";
  const list = weapon ? hero.equipped : hero.equippedSkills;
  const owned = weapon ? hero.weapons.includes(move.id) : move.id in hero.skills;
  if (!owned) return { ok: false, reason: weapon ? "尚未获得该武器" : "尚未习得该技能" };
  const cap = weapon ? hero.slots : SKILL_SLOTS;
  const fromOn = list.includes(move.id);
  const targetOn = list.includes(move.targetId);
  let next = [...list];
  if (move.toZone === "on") {
    if (fromOn) {
      if (!targetOn || move.targetId === move.id) return { ok: true, changed: false };
      next = next.filter((x) => x !== move.id);
      next.splice(next.indexOf(move.targetId) + (move.before ? 0 : 1), 0, move.id);
    } else if (next.length < cap) {
      const at = targetOn ? next.indexOf(move.targetId) + (move.before ? 0 : 1) : next.length;
      next.splice(at, 0, move.id);
    } else if (targetOn) next = next.map((x) => (x === move.targetId ? move.id : x));
    else return { ok: false, reason: `${weapon ? "武器" : "技能"}槽已满：拖到要替换的那一件上` };
  } else {
    if (!fromOn) return { ok: true, changed: false };
    const swapIn = move.targetId && !list.includes(move.targetId) && move.targetId !== move.id ? move.targetId : null;
    if (swapIn) next = next.map((x) => (x === move.id ? swapIn : x));
    else if (weapon && next.length <= 1) return { ok: false, reason: "至少需要一件出战武器" };
    else next = next.filter((x) => x !== move.id);
  }
  if (weapon) hero.equipped = next;
  else hero.equippedSkills = next;
  return { ok: true, changed: true };
}

/** 武器实际的冷却。 */
export function weaponCooldown(id) {
  return WEAPONS[id].cooldown;
}
