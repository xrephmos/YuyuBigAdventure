import {
  resolveHits,
  resolveHeal,
  footprint,
  inBounds,
  applyChanges,
  isDead,
  rankPlacements,
  cloneMatrix,
  EMPTY,
  HEART,
  ARMOR,
  VOID,
} from "./shapes.js";
import { WEAPONS, SHIELD, POTION } from "../data/weapons.js";
import { SKILLS } from "../data/skills.js";
import { getHeroName } from "../data/heroName.js";
import { ALL_FEATURES } from "../data/features.js";
import { weaponShape, nextRotation, toggleExtent, weaponCooldown, isLineShape } from "./arsenal.js";

/**
 * 充能：中型、重型武器每用一次要消耗充能，充能靠连击攒。
 *   - 每场战斗开局给 ENERGY_START 点，最多攒 ENERGY_MAX 点；
 *   - 每连上一次（连击 ×1 起）得 ENERGY_PER_LINK 点；
 *   - 中型武器 1 点，重武器 2 点：开局的 1 点只够用一次中型武器，重武器必须先连上一下才抡得起来，
 *     之后“轻武器连几下 → 一锤”可以循环下去（像老式发动机，先摇几下打着火，然后就转起来了）。
 *
 * 这组数值是用模拟对局调出来的（第 1–11 章所有怪物、两种玩家：只挑当下最好的一击 / 会给重武器攒充能）：
 *   前期（还没有重武器）轻武器 + 中型武器刷连击，中型武器打掉约四成的心，回合数和改动前一样；
 *   后期战锤带上延长 / 巨化后，带重武器比不带快 12–14%，重武器打掉 35–40% 的心，一场用两三次；
 *   改动前（开局 2、每次 +1 且 ×2 起、重武器 3 点）只会挑当下最好一击的玩家几乎用不上重武器。
 *   连击求解器（tests/helpers/chainSolver.js）验证过：每种怪物首次登场时仍能用一条连击打完。
 */
export const ENERGY_START = 1;
export const ENERGY_MAX = 6;
export const ENERGY_PER_LINK = 2;
export const ENERGY_COST = { light: 0, medium: 1, heavy: 2 };

/** 每连上 CHASE_EVERY 次（连击 ×3、×6、×9……）获得一次追击：怪物行动前再出一招。 */
export const CHASE_EVERY = 3;

/** 吸血：打出追击时回复的红心数。 */
export const LEECH_HEAL = 2;

/** 招式要消耗几点充能：技能不消耗。 */
export const energyCost = (slot) => (slot.kind === "weapon" ? ENERGY_COST[WEAPONS[slot.id].weight] ?? 0 : 0);

/** 可复现的伪随机数，便于测试与平衡模拟。 */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

/**
 * 回合制战斗状态机，不依赖 DOM。
 * phase：hero（等待主角行动）→ monster（等待怪物行动）→ hero …，直到 won / lost / fled。
 */
export function createCombat({
  hero,
  monster,
  heroFirst = true,
  rng = Math.random,
  // 已经解锁的战斗机制（见 data/features.js）；没解锁的动作直接拒绝，连击也不计。
  features = ALL_FEATURES,
}) {
  const state = {
    features,
    def: monster.def,
    heroMatrix: cloneMatrix(hero.matrix),
    monsterMatrix: cloneMatrix(monster.matrix),
    // 武器与技能共用一排“招式位”：武器有冷却和朝向，技能有剩余次数。
    // 只有装备在武器槽 / 技能槽里的招式才会进入战斗。
    weapons: [
      ...(hero.equipped ?? hero.weapons).map((id) => ({ id, kind: "weapon", cd: 0, orient: { rot: 0, flip: false, ext: 0 } })),
      ...Object.entries(hero.skills ?? {})
        .filter(([id]) => !hero.equippedSkills || hero.equippedSkills.includes(id))
        .map(([id, charges]) => ({ id, kind: "skill", cd: 0, charges })),
    ],
    combo: 0,
    bestCombo: 0,
    energy: ENERGY_START,
    // 怪物下一招是回血时，要补回的格子（连成一片，挨着现有的心），界面上提前标出来。
    healPlan: null,
    // 上一击覆盖的格子（含界外），用来判断这一击是否紧挨着上一击。
    lastFootprint: null,
    // 上一击用的招式：连续两次用同一件武器（或同一个技能）不算连上。
    lastWeaponId: null,
    upgrades: hero.upgrades ?? {},
    // 追加攻击：bonus 为 true 时怪物暂不行动，主角再出一招。bonusReason：chase 追击 / swift 突刺。
    bonus: false,
    bonusReason: null,
    stunned: false,
    potions: hero.potions,
    shieldCd: 0,
    shieldUp: false,
    // 招架：本回合用带招架的武器接上过连击，怪物下一招少打 1 颗心（每回合最多一次）。
    parried: false,
    // 被死灭抹去的格子 [[r, c], ...]：心阵上已经没有这一格，界面在原位置画一个 ×。
    doomed: [],
    step: monster.step ?? 0,
    round: 1,
    intent: null,
    aim: null,
    phase: heroFirst ? "hero" : "monster",
    retreating: false,
    canRetreat: !monster.def.boss,
    heroFirst,
    rng,
    log: [],
    stats: { dealt: 0, taken: 0, blocked: 0 },
  };
  planIntent(state);
  state.log.push(
    heroFirst
      ? `${getHeroName()}向${state.def.name}发起攻击。`
      : `${state.def.name}发起突袭。`,
  );
  return state;
}

/** 怪物当前的招式循环：首领进入二阶段后换成新的一套。 */
export const patternOf = (state) => state.pattern ?? state.def.pattern;

export function planIntent(state) {
  const { aim } = state.def;
  const pattern = patternOf(state);
  state.intent = pattern[state.step % pattern.length];
  state.aim = null;
  state.healPlan = state.intent.kind === "heal" ? healRegion(state.monsterMatrix, state.intent.amount, state.rng) : null;
  if (state.intent.kind !== "attack") return;
  const ranked = rankPlacements(state.heroMatrix, state.intent.shape);
  if (!ranked.length) return;
  if (state.rng() < aim) {
    const best = ranked.filter((p) => p.damage === ranked[0].damage);
    state.aim = pick(best, state.rng);
  } else state.aim = pick(ranked, state.rng);
}

/** 主角当前可用的动作检查，界面据此禁用按钮。 */
export function weaponReady(state, weaponId) {
  const slot = state.weapons.find((w) => w.id === weaponId);
  return Boolean(slot && slot.cd === 0);
}

export const slotOf = (state, id) => state.weapons.find((w) => w.id === id);

/** 招式的定义（武器或技能）。 */
export const slotDef = (slot) => (slot.kind === "skill" ? SKILLS[slot.id] : WEAPONS[slot.id]);

/** 招式当前的攻击形状：技能固定；武器考虑延长与当前朝向。 */
export function slotShape(state, slot) {
  return slot.kind === "skill" ? SKILLS[slot.id].shape : weaponShape(slot.id, state.upgrades, slot.orient);
}

/** 招式此刻能否使用；不能时给出原因。 */
export function slotBlocked(state, slot) {
  if (slot.kind === "skill") {
    if (slot.charges <= 0) return `${SKILLS[slot.id].name}本章次数已用尽`;
    if (state.bonus) return "追加攻击只能使用武器";
    return null;
  }
  if (slot.cd > 0) return `${WEAPONS[slot.id].name}还需冷却 ${slot.cd} 回合`;
  const cost = energyCost(slot);
  if (cost > state.energy) return `${WEAPONS[slot.id].name}需要 ${cost} 点充能`;
  return null;
}

/** 招式是否破甲：破甲锥、碎甲天生破甲，武器可以通过强化获得。 */
export const slotPierce = (state, slot) =>
  Boolean(slotDef(slot).pierce || (slot.kind === "weapon" && state.upgrades[slot.id]?.pierce));

/** 怪物蓄力之后的那一招重击，可以被重武器打断。 */
export function interruptible(state) {
  const p = patternOf(state);
  const prev = p[(state.step - 1 + p.length) % p.length];
  return state.phase === "hero" && state.intent?.kind === "attack" && prev?.kind === "charge";
}

/** 打断需要这一击打碎几颗心：3 颗，带「震慑」强化的武器 2 颗。 */
export const interruptThreshold = (state, slot) => (slot.kind === "weapon" && state.upgrades[slot.id]?.stagger ? 2 : 3);

export function canInterrupt(state, slot, broken) {
  return slot.kind === "weapon" && WEAPONS[slot.id].weight === "heavy" && interruptible(state) && broken >= interruptThreshold(state, slot);
}

/** 预览：这一击会不会打断重击。 */
export function previewInterrupt(state, weaponId, r, c) {
  const slot = slotOf(state, weaponId);
  if (!slot || slot.kind !== "weapon") return false;
  const broken = previewAttack(state, weaponId, r, c).filter((h) => h.after === EMPTY).length;
  return canInterrupt(state, slot, broken);
}

/** 不落空：形状的每一格都落在矩阵内、还有心的格子上（护甲心也算）。 */
export function isClean(matrix, cells) {
  return cells.every(([r, c]) => inBounds(matrix, r, c) && matrix[r][c] > EMPTY);
}


/** 两次攻击的范围是否相邻：有格子重合，或上下左右紧挨着。 */
export function touches(a, b) {
  return a.some(([r, c]) => b.some(([r2, c2]) => Math.abs(r - r2) + Math.abs(c - c2) <= 1));
}

/**
 * 这一击对连击的影响。
 * break：落空，连击清零。
 * repeat：没落空，但和上一击用的是同一件武器，从这一击重新起手（照常造成伤害，只是刷不了连击）。
 * start：没落空，但不挨着上一击（或还没有连击），从这一击重新起手。
 * link：没落空、换了武器、并且紧挨着上一击，连击 +1。
 */
export function comboOutcome(state, shape, r, c, weaponId) {
  const cells = footprint(shape, r, c);
  if (!isClean(state.monsterMatrix, cells)) return "break";
  if (state.combo === 0 || !state.lastFootprint) return "start";
  if (weaponId && weaponId === state.lastWeaponId) return "repeat";
  return touches(cells, state.lastFootprint) ? "link" : "start";
}

export function previewCombo(state, weaponId, r, c) {
  return comboOutcome(state, attackShape(state, weaponId, r, c), r, c, weaponId);
}

/**
 * 这一击实际的攻击形状。平时就是招式的形状；带「贯通」的直线形武器，
 * 会从两端沿自身方向继续延伸，一直延伸到遇到空位（或心阵边缘）为止——延伸出来的每一格都是红心，
 * 所以“每一格都落在红心上”这条规则不受影响。
 */
export function attackShape(state, weaponId, r, c) {
  const slot = slotOf(state, weaponId);
  const shape = slotShape(state, slot);
  if (slot.kind !== "weapon" || !state.upgrades[slot.id]?.line || !isLineShape(shape)) return shape;
  const m = state.monsterMatrix;
  const cells = footprint(shape, r, c);
  // 只有完全落在红心上的直线才会延伸：落空的一击照常判定为落空。
  if (!isClean(m, cells)) return shape;
  const [dr, dc] = [Math.sign(cells[1][0] - cells[0][0]), Math.sign(cells[1][1] - cells[0][1])];
  const alive = (rr, cc) => inBounds(m, rr, cc) && m[rr][cc] > EMPTY;
  const extra = [];
  for (let [rr, cc] = [cells[0][0] - dr, cells[0][1] - dc]; alive(rr, cc); rr -= dr, cc -= dc) extra.push([rr, cc]);
  const last = cells[cells.length - 1];
  for (let [rr, cc] = [last[0] + dr, last[1] + dc]; alive(rr, cc); rr += dr, cc += dc) extra.push([rr, cc]);
  if (!extra.length) return shape;
  const offsets = [...shape.offsets, ...extra.map(([rr, cc]) => [rr - r, cc - c])];
  return { ...shape, offsets, size: offsets.length };
}

/**
 * 连击的显示：第一次完美命中只是起手，不提示；第二次起才算连上。
 * 内部的 combo 记连续完美命中的次数，界面显示 combo - 1；每连上一次得 ENERGY_PER_LINK 点充能；
 * 每到 ×3 的倍数获得一次追击。
 */
export const comboLinks = (combo) => Math.max(0, combo - 1);

/** 连击数从 before 涨到 after 时，有没有跨过一个追击点（×3、×6……）。 */
export const reachesChase = (before, after) => Math.floor(after / CHASE_EVERY) > Math.floor(before / CHASE_EVERY);
export const comboLabel = (links) => (links <= 1 ? "连击" : `连击 ×${links}`);

export function previewAttack(state, weaponId, r, c) {
  const slot = slotOf(state, weaponId);
  return resolveHits(state.monsterMatrix, attackShape(state, weaponId, r, c), r, c, { pierce: slotPierce(state, slot) });
}

/** 变形（不消耗回合）：旋转到下一个朝向、左右翻转，或在原形状与加长形状之间切换。只对拥有对应强化的武器生效。 */
export function heroTransform(state, weaponId, kind) {
  const slot = slotOf(state, weaponId);
  if (!slot || slot.kind !== "weapon") return { ok: false, reason: "技能不可变形" };
  if (!state.upgrades[weaponId]?.[kind]) return { ok: false, reason: `${WEAPONS[weaponId].name}没有这项强化` };
  if (kind === "rotate") slot.orient = { ...slot.orient, rot: nextRotation(weaponId, state.upgrades, slot.orient) };
  else if (kind === "mirror") slot.orient = { ...slot.orient, flip: !slot.orient.flip };
  else if (kind === "extend" || kind === "giant") {
    if (kind === "giant" && !WEAPONS[weaponId].giantShape) return { ok: false, reason: "无法巨化" };
    slot.orient = { ...slot.orient, ext: toggleExtent(kind, slot.orient) };
  }
  else return { ok: false, reason: "无法变形" };
  return { ok: true };
}

/** 汲血：按消除的红心数，从上到下、从左到右补回主角失去的红心。 */
function drainHeal(state, amount) {
  const changes = [];
  state.heroMatrix.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v === EMPTY && changes.length < amount) changes.push({ r, c, before: EMPTY, after: HEART });
    }),
  );
  state.heroMatrix = applyChanges(state.heroMatrix, changes);
  return changes;
}

export function previewHeal(state, r, c) {
  return resolveHeal(state.heroMatrix, POTION.shape, r, c);
}

/**
 * 连击结算：连上就累计连击；每连上一次得 ENERGY_PER_LINK 点充能；每到 ×3 的倍数追击一次。
 * 返回这一击是否触发追击。事件与日志直接写进 events / state.log。
 */
function settleCombo(state, slot, outcome, wasBonus, events) {
  const linksBefore = comboLinks(state.combo);
  if (outcome === "break") {
    if (linksBefore) {
      state.log.push("连击中断。");
      events.push({ type: "combo-break" });
    }
    state.combo = 0;
    return false;
  }
  // 不挨着上一击或连用同一件武器：之前的连击断开，从这一击重新起手。
  if (outcome !== "link") {
    if (linksBefore) {
      state.log.push(outcome === "repeat" ? "连续使用同一件武器，连击中断。" : "连击中断。");
      events.push({ type: "combo-break" });
    }
    state.combo = 0;
  }
  const up = slot.kind === "weapon" ? state.upgrades[slot.id] ?? {} : {};
  // 连锁：这件武器连上时连击多涨一次。
  state.combo += outcome === "link" && up.chain ? 2 : 1;
  state.bestCombo = Math.max(state.bestCombo, state.combo);
  const links = comboLinks(state.combo);
  let earn = 0;
  if (outcome === "link") earn += ENERGY_PER_LINK;
  if (outcome === "link" && up.precise) earn += 1;
  // 招架：用这件武器接上连击时，怪物下一招少打 1 颗心；一回合里接上几次都只算一次。
  if (outcome === "link" && up.parry && !state.parried) {
    state.parried = true;
    state.log.push("招架：怪物下一招少打 1 颗心。");
    events.push({ type: "parry" });
  }
  const before = state.energy;
  state.energy = Math.min(ENERGY_MAX, state.energy + earn);
  const gained = state.energy - before;
  // 追击本身（以及突刺的追加攻击）不会再触发追击，避免一口气打到底。
  const chase = outcome === "link" && !wasBonus && reachesChase(linksBefore, links);
  if (links) state.log.push(`${comboLabel(links)}${gained ? `，充能 +${gained}` : ""}${chase ? "，追击！" : "。"}`);
  events.push({ type: "combo", combo: state.combo, energy: gained, chase });
  return chase;
}

export function heroAttack(state, weaponId, r, c) {
  if (state.phase !== "hero") return { ok: false, reason: "当前不是己方回合" };
  const slot = slotOf(state, weaponId);
  if (!slot) return { ok: false, reason: "未装备该武器" };
  const blocked = slotBlocked(state, slot);
  if (blocked) return { ok: false, reason: blocked };
  const def = slotDef(slot);
  const shape = attackShape(state, weaponId, r, c);
  const hits = resolveHits(state.monsterMatrix, shape, r, c, { pierce: slotPierce(state, slot) });
  if (!hits.length) return { ok: false, reason: "范围内没有可消除的红心" };
  const outcome = comboOutcome(state, shape, r, c, weaponId);
  state.lastFootprint = footprint(shape, r, c);
  state.lastWeaponId = weaponId;
  state.monsterMatrix = applyChanges(state.monsterMatrix, hits);
  // 这一击是不是追击（连击 ×3 之后多出的那一击）：吸血只在追击时生效。
  const chaseHit = state.bonus && state.bonusReason === "chase";
  // 死灭：用它接上连击的这一击，消除的格子直接从心阵上抹去（变成空位），怪物再也不能在这里回血。
  // 起手的第一击、断了连击的一击都不生效。
  const doomed = slot.kind === "weapon" && outcome === "link" && state.upgrades[slot.id]?.doom ? hits.filter((h) => h.after === EMPTY) : [];
  if (doomed.length) {
    state.monsterMatrix = applyChanges(state.monsterMatrix, doomed.map((h) => ({ ...h, after: VOID })));
    // 记下被抹去的格子：界面上画一个黑色的 ×，让玩家知道这里曾经有过心。
    state.doomed = [...state.doomed, ...doomed.map(({ r: hr, c: hc }) => [hr, hc])];
  }
  const wasBonus = state.bonus;
  state.bonus = false;
  state.bonusReason = null;
  state.energy -= energyCost(slot);
  if (slot.kind === "skill") slot.charges -= 1;
  // 新回合开始时会先减 1，因此存 cooldown+1，保证之后整整 cooldown 个回合不可用。
  else {
    const cooldown = weaponCooldown(slot.id, state.upgrades);
    slot.cd = cooldown ? cooldown + 1 : 0;
  }
  const broken = hits.filter((h) => h.after === EMPTY).length;
  const cracked = hits.length - broken;
  const interrupts = canInterrupt(state, slot, broken);
  state.stats.dealt += broken;
  state.log.push(`${def.name}消除了 ${broken} 颗红心${cracked ? `，击破 ${cracked} 层护甲` : ""}。`);
  const events = [{ type: "hero-attack", weapon: def, hits, anchor: [r, c] }];
  if (interrupts) {
    state.interrupted = true;
    state.log.push(`${def.name}打断了「${state.intent.name}」。`);
    events.push({ type: "interrupt", intent: state.intent });
    // 震地：打断之后，怪物再晕眩一回合。
    if (state.upgrades[slot.id]?.quake) {
      state.stunned = true;
      state.log.push(`${state.def.name}被震倒，下回合无法行动。`);
    }
  }
  if (doomed.length) events.push({ type: "doom", cells: doomed.map(({ r: hr, c: hc }) => [hr, hc]) });

  // 吸血：用带吸血的武器打出追击，回复 2 颗红心（补在失去的心上，从上到下、从左到右）。
  if (slot.kind === "weapon" && chaseHit && state.upgrades[slot.id]?.leech) {
    const changes = drainHeal(state, LEECH_HEAL);
    if (changes.length) {
      state.log.push(`吸血为${getHeroName()}恢复了 ${changes.length} 颗红心。`);
      events.push({ type: "heal", side: "hero", changes });
    }
  }
  if (slot.kind === "skill" && def.effect === "drain" && broken) {
    const changes = drainHeal(state, broken);
    if (changes.length) {
      state.log.push(`${def.name}为${getHeroName()}恢复了 ${changes.length} 颗红心。`);
      events.push({ type: "heal", side: "hero", changes });
    }
  }
  if (slot.kind === "skill" && def.effect === "stun") {
    state.stunned = true;
    state.log.push(`${state.def.name}被定身，下回合无法行动。`);
  }

  // 还没学到连击（序章只有短剑）时不计连击。
  const chase = state.features.has("combo") ? settleCombo(state, slot, outcome, wasBonus, events) : false;

  if (isDead(state.monsterMatrix) && state.def.rebirth && !state.reborn) {
    rebirth(state, events);
  } else if (isDead(state.monsterMatrix)) {
    state.phase = "won";
    state.log.push(`${state.def.name}被击败。`);
    events.push({ type: "won" });
  } else if (chase) {
    // 追击：怪物行动前，立刻再用一次武器。
    state.bonus = true;
    state.bonusReason = "chase";
    events.push({ type: "bonus", reason: "chase" });
  } else if (slot.kind === "skill" && def.effect === "extra" && !wasBonus) {
    // 突刺：本回合还可以再用一次普通武器，怪物暂不行动。
    state.bonus = true;
    state.bonusReason = "swift";
    state.log.push("突刺生效，可追加一次攻击。");
    events.push({ type: "bonus", reason: "swift" });
  } else state.phase = "monster";
  return { ok: true, events };
}

/**
 * 首领的二阶段：心阵第一次清空时不倒下，换成另一种形状的心阵重新补满，招式循环换成新的一套，从头开始。
 * 连击、追击、定身、打断都清零；主角的武器冷却也一并清空，喘一口气，仍由主角先出手。
 */
function rebirth(state, events) {
  const next = state.def.rebirth;
  state.reborn = true;
  state.monsterMatrix = cloneMatrix(next.matrixValues);
  state.doomed = [];
  state.pattern = next.pattern;
  state.step = 0;
  // 连击清零即可：上一击的范围留着给界面播打击闪光，连击数为 0 时它不会被当成“连上”。
  state.combo = 0;
  state.lastWeaponId = null;
  state.bonus = false;
  state.bonusReason = null;
  state.stunned = false;
  state.interrupted = false;
  for (const slot of state.weapons) if (slot.kind === "weapon") slot.cd = 0;
  state.phase = "hero";
  state.log.push(`${state.def.name}的王冠倾斜了，墨迹重新聚拢。`);
  events.push({ type: "rebirth", title: next.title });
  planIntent(state);
}

/** 某项机制还没解锁时给出的拒绝结果；解锁了返回 null。 */
const locked = (state, feature) => (state.features.has(feature) ? null : { ok: false, reason: "该操作尚未解锁" });

export function heroHeal(state, r, c) {
  if (state.phase !== "hero") return { ok: false, reason: "当前不是己方回合" };
  const lock = locked(state, "potion");
  if (lock) return lock;
  if (state.potions <= 0) return { ok: false, reason: "药水已用尽" };
  const heals = resolveHeal(state.heroMatrix, POTION.shape, r, c);
  if (!heals.length) return { ok: false, reason: "范围内没有需要恢复的红心" };
  state.heroMatrix = applyChanges(state.heroMatrix, heals);
  state.potions -= 1;
  state.bonus = false;
  state.bonusReason = null;
  state.log.push(`使用红心药水，恢复了 ${heals.length} 颗红心。`);
  state.phase = "monster";
  return { ok: true, events: [{ type: "heal", side: "hero", changes: heals }] };
}

export function heroShield(state) {
  if (state.phase !== "hero") return { ok: false, reason: "当前不是己方回合" };
  const lock = locked(state, "shield");
  if (lock) return lock;
  if (state.shieldUp) return { ok: false, reason: "已处于防御状态" };
  if (state.shieldCd > 0)
    return { ok: false, reason: `防御还需冷却 ${state.shieldCd} 回合` };
  state.shieldUp = true;
  state.shieldCd = SHIELD.cooldown + 1;
  state.log.push(`${getHeroName()}进入防御状态。`);
  return { ok: true, events: [{ type: "shield" }] };
}

/**
 * 等待：不攻击，直接结束本回合（连击保留）。
 * 保证任何时候都有合法动作：例如装备的武器全部在冷却、又没有药水时。
 */
export function heroWait(state) {
  if (state.phase !== "hero") return { ok: false, reason: "当前不是己方回合" };
  const lock = locked(state, "wait");
  if (lock) return lock;
  state.bonus = false;
  state.bonusReason = null;
  state.phase = "monster";
  state.log.push(`${getHeroName()}等待一回合。`);
  return { ok: true, events: [{ type: "wait" }] };
}

export function heroRetreat(state) {
  if (state.phase !== "hero") return { ok: false, reason: "当前不是己方回合" };
  const lock = locked(state, "retreat");
  if (lock) return lock;
  if (!state.canRetreat) return { ok: false, reason: "暗王战无法撤退" };
  state.retreating = true;
  state.bonus = false;
  state.bonusReason = null;
  state.phase = "monster";
  state.log.push(`${getHeroName()}撤退，${state.def.name}发起追击。`);
  return { ok: true, events: [{ type: "retreat" }] };
}

const ORTHO4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * 回血的范围：一片连在一起的空格，并且挨着现有的心（像伤口从边上慢慢长回来）。
 * 从每个挨着心的空格出发往外扩，挑能补得最多的那一片；一样多时随机挑。
 */
export function healRegion(matrix, amount, rng = Math.random) {
  const empty = (r, c) => matrix[r]?.[c] === EMPTY;
  const alive = (r, c) => matrix[r]?.[c] > EMPTY;
  const seeds = [];
  matrix.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v === EMPTY && ORTHO4.some(([dr, dc]) => alive(r + dr, c + dc))) seeds.push([r, c]);
    }),
  );
  let best = [];
  let ties = 0;
  for (const [sr, sc] of seeds) {
    const seen = new Set([`${sr},${sc}`]);
    const region = [[sr, sc]];
    for (let i = 0; i < region.length && region.length < amount; i += 1) {
      const [r, c] = region[i];
      for (const [dr, dc] of ORTHO4) {
        const k = `${r + dr},${c + dc}`;
        if (region.length < amount && empty(r + dr, c + dc) && !seen.has(k)) {
          seen.add(k);
          region.push([r + dr, c + dc]);
        }
      }
    }
    if (region.length > best.length) {
      best = region;
      ties = 1;
    } else if (region.length === best.length && rng() < 1 / (ties += 1)) best = region;
  }
  return best;
}

/**
 * 按计划回血。计划里的格子要还空着，而且要连着一颗活着的心；
 * 玩家在这之前打碎了伤口旁边的心，这一片就接不上，回血落空。
 */
function monsterHeal(state, amount) {
  const m = state.monsterMatrix;
  let cells = state.healPlan ?? healRegion(m, amount, state.rng);
  const planned = new Set(cells.filter(([r, c]) => m[r][c] === EMPTY).map(([r, c]) => `${r},${c}`));
  const reach = [];
  for (const k of planned) {
    const [r, c] = k.split(",").map(Number);
    if (ORTHO4.some(([dr, dc]) => m[r + dr]?.[c + dc] > EMPTY)) reach.push([r, c]);
  }
  const seen = new Set(reach.map(([r, c]) => `${r},${c}`));
  for (let i = 0; i < reach.length; i += 1) {
    const [r, c] = reach[i];
    for (const [dr, dc] of ORTHO4) {
      const k = `${r + dr},${c + dc}`;
      if (planned.has(k) && !seen.has(k)) {
        seen.add(k);
        reach.push([r + dr, c + dc]);
      }
    }
  }
  cells = reach.slice(0, amount);
  const changes = cells.map(([r, c]) => ({ r, c, before: EMPTY, after: HEART }));
  state.monsterMatrix = applyChanges(m, changes);
  state.healPlan = null;
  return changes;
}

function monsterArmor(state, amount) {
  const m = state.monsterMatrix;
  const hearts = [];
  m.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v === HEART) hearts.push({ r, c });
    }),
  );
  const changes = [];
  while (changes.length < amount && hearts.length) {
    const index = Math.floor(state.rng() * hearts.length);
    const [{ r, c }] = hearts.splice(index, 1);
    changes.push({ r, c, before: HEART, after: ARMOR });
  }
  state.monsterMatrix = applyChanges(m, changes);
  return changes;
}

/** 执行怪物当前意图，随后开启主角新回合（或结束战斗）。 */
export function monsterTurn(state) {
  if (state.phase !== "monster") return { ok: false, events: [] };
  const intent = state.intent;
  const name = state.def.name;
  const events = [];
  if (state.stunned) {
    // 定身：本次行动作废，招式顺序也不前进。
    state.stunned = false;
    state.log.push(`${name}被定身，本回合无法行动。`);
    events.push({ type: "stunned" });
    if (state.retreating) {
      state.phase = "fled";
      state.log.push("撤退成功。");
      events.push({ type: "fled" });
    } else startHeroTurn(state);
    return { ok: true, events };
  }
  if (state.interrupted) {
    // 重击被打断：这一招作废，招式顺序照常前进。
    state.interrupted = false;
    state.log.push(`${name}的「${intent.name}」被打断了。`);
    events.push({ type: "interrupted", intent });
  } else if (intent.kind === "attack") {
    if (state.shieldUp) {
      state.shieldUp = false;
      const would = state.aim
        ? resolveHits(state.heroMatrix, intent.shape, state.aim.r, state.aim.c)
        : [];
      state.stats.blocked += would.length;
      state.log.push(`防御挡下了「${intent.name}」。`);
      events.push({ type: "monster-attack", intent, hits: [], blocked: true, anchor: state.aim });
    } else {
      const hits = monsterHits(state);
      if (state.parried && state.aim) state.log.push("招架卸掉了 1 颗心的伤害。");
      state.heroMatrix = applyChanges(state.heroMatrix, hits);
      state.stats.taken += hits.length;
      state.log.push(
        hits.length
          ? `${name}使用「${intent.name}」，消除了 ${hits.length} 颗红心。`
          : `${name}的「${intent.name}」没有命中。`,
      );
      events.push({ type: "monster-attack", intent, hits, anchor: state.aim });
    }
  } else if (intent.kind === "charge") {
    state.log.push(`${name}正在蓄力。`);
    events.push({ type: "charge", intent });
  } else if (intent.kind === "heal") {
    const changes = monsterHeal(state, intent.amount);
    state.log.push(
      changes.length
        ? `${name}使用「${intent.name}」，恢复了 ${changes.length} 颗红心。`
        : `${name}使用「${intent.name}」，没有恢复任何红心。`,
    );
    events.push({ type: "heal", side: "monster", changes });
  } else if (intent.kind === "armor") {
    const changes = monsterArmor(state, intent.amount);
    state.log.push(`${name}使用「${intent.name}」，${changes.length} 颗红心获得护甲。`);
    events.push({ type: "armor", changes });
  } else if (intent.kind === "curse") {
    if (state.shieldUp) {
      state.shieldUp = false;
      state.log.push(`防御挡下了「${intent.name}」。`);
      events.push({ type: "curse", blocked: true });
    } else {
      // 短剑等无冷却的基础武器不受影响，保证主角总有招可出。
      for (const slot of state.weapons)
        if (slot.kind === "weapon" && WEAPONS[slot.id].cooldown) slot.cd = Math.max(slot.cd, 1) + intent.amount;
      state.log.push(`${name}使用「${intent.name}」，武器冷却 +${intent.amount}${comboLinks(state.combo) ? "，连击中断" : ""}。`);
      state.combo = 0;
      events.push({ type: "curse", blocked: false, amount: intent.amount });
    }
  }
  state.step += 1;
  // 招架只管怪物的下一招：无论这一招是不是攻击，用过就清掉。
  state.parried = false;

  if (isDead(state.heroMatrix)) {
    state.phase = "lost";
    state.log.push(`${getHeroName()}的红心已全部消除。`);
    events.push({ type: "lost" });
  } else if (state.retreating) {
    state.phase = "fled";
    state.log.push("撤退成功。");
    events.push({ type: "fled" });
  } else {
    startHeroTurn(state);
  }
  return { ok: true, events };
}

/**
 * 怪物这一招（攻击）实际会打掉主角的哪些心：瞄准范围里的心，招架过就少打最后一颗。
 * 战斗界面的伤害预告也用它，预告与结算保持一致。
 */
export function monsterHits(state) {
  const hits = aimedHits(state);
  return state.parried ? hits.slice(0, -1) : hits;
}

/** 招架保住的那颗心（界面上画成蓝色描边）；没有招架或打不到心时为 null。 */
export function parriedCell(state) {
  if (!state.parried) return null;
  const last = aimedHits(state).at(-1);
  return last ? [last.r, last.c] : null;
}

/** 怪物攻击瞄准范围内的全部红心（还没算招架）。 */
function aimedHits(state) {
  if (state.intent?.kind !== "attack" || !state.aim) return [];
  return resolveHits(state.heroMatrix, state.intent.shape, state.aim.r, state.aim.c);
}

function startHeroTurn(state) {
  for (const slot of state.weapons) slot.cd = Math.max(0, slot.cd - 1);
  state.shieldCd = Math.max(0, state.shieldCd - (state.shieldUp ? 0 : 1));
  state.round += 1;
  state.phase = "hero";
  planIntent(state);
}

export function hasAnyAction(state) {
  return state.weapons.some((w) => w.cd === 0) || state.potions > 0;
}

/** 战斗结束后各技能剩余的次数，写回棋盘。 */
export function skillCharges(state) {
  return Object.fromEntries((state.weapons ?? []).filter((w) => w.kind === "skill").map((w) => [w.id, w.charges]));
}
