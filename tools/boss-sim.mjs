/**
 * 暗王战模拟：同一套主角配置打很多局，看胜率、回合数和剩余红心。只模拟暗王这一场（不含之前的两座城堡）。
 *
 *   node tools/boss-sim.mjs [局数] [开战时的红心比例 0~1] [药水数]
 *
 * 强化分三档对比：
 *   - 零强化：一项强化都没有；
 *   - 实际攒下来：终章之前一共经过多少座铁砧就抽多少次（每座三选一，进阶强化整局 1～3 次，
 *     只从当时已拿到的武器里出，破甲 / 震慑 / 死灭要等对应的怪物出场后才会刷出），每次挑最实用的一项；
 *   - 满强化：开发者模式的满配（实战拿不到，作为上限参考）。
 *
 * 模拟玩家的打法（比随手乱打聪明，但不做长远规划）：
 *   - 怪物下一招打得多（5 格以上）且防御可用时先防御；
 *   - 红心低于四成、手里有药水时喝药，补在恢复最多的位置；
 *   - 否则在所有可用的招式、所有能切换的朝向与长短（旋转、镜像、延长、巨化）、所有落点里，
 *     挑「伤害 + 连击 + 打断」得分最高的一个。
 */
import { createCombat, createRng, heroAttack, heroShield, heroHeal, monsterTurn, slotBlocked, slotShape, slotPierce, comboOutcome, canInterrupt } from "../src/battle/logic/combat.js";
import { MONSTERS, heartsAt } from "../src/battle/data/monsters.js";
import { LEVELS, weaponsForLevel, skillsForLevel } from "../src/battle/data/levels.js";
import { STARTING_WEAPONS, POTION } from "../src/battle/data/weapons.js";
import { SKILLS } from "../src/battle/data/skills.js";
import { filledMatrix, rankPlacements, countHearts, resolveHeal, VOID, EMPTY } from "../src/battle/logic/shapes.js";
import { upgradeOptions, applyUpgrade, planAdvancedForges, hasAdvancedOption, isAdvanced } from "../src/battle/logic/arsenal.js";
import { devLoadout } from "../src/battle/logic/devMode.js";

const index = LEVELS.findIndex((l) => l.key === "checkmate");
const level = LEVELS[index];
const owned = weaponsForLevel(index, STARTING_WEAPONS);
// 出战武器：轻、中、重都带上，按章节武器槽数截断。
const PRIORITY = ["dagger", "hook", "hammer", "slash", "cross", "awl", "scythe", "spear"];
const equipped = PRIORITY.filter((id) => owned.includes(id)).slice(0, level.slots);
const skills = skillsForLevel(index, SKILLS);
const equippedSkills = Object.keys(skills).slice(-3);

// ——— 强化 ———

const countForges = (lvl) => lvl.map.join("").split("U").length - 1;
const firstChapter = (test) => LEVELS.findIndex((l) => l.monsters.some((m) => test(MONSTERS[m.type])));
const ARMOR_AT = firstChapter((def) => def.armored);
const CHARGE_AT = firstChapter((def) => def.pattern.some((p) => p.kind === "charge"));
const HEAL_AT = firstChapter((def) => def.pattern.some((p) => p.kind === "heal"));

/** 玩家挑强化的偏好：进阶强化 > 让大武器更大 > 回血与减伤 > 精准 > 破甲 / 震慑 > 变形；出战的武器优先。 */
const PREFERENCE = { giant: 9, quake: 8, chain: 8, doom: 8, line: 8, extend: 7, leech: 6, parry: 6, precise: 5, pierce: 4, stagger: 4, rotate: 2, mirror: 2 };
const score = (o) => (PREFERENCE[o.kind] ?? 1) + (isAdvanced(o.kind) ? 10 : 0) + (equipped.includes(o.weapon) ? 3 : 0);

/** 按章节顺序走一遍终章之前（含终章决战前）的所有铁砧，返回攒下来的强化。 */
function earnedUpgrades(rng) {
  const total = LEVELS.slice(0, index + 1).reduce((n, l) => n + countForges(l), 0);
  const plan = planAdvancedForges({ total }, rng);
  const hero = { weapons: [], upgrades: {} };
  let used = 0;
  let pending = 0;
  for (let i = 0; i <= index; i += 1) {
    hero.weapons = weaponsForLevel(i + 1 > index ? index : i + 1, STARTING_WEAPONS);
    const opts = { pierce: i >= ARMOR_AT, stagger: i >= CHARGE_AT, heal: i >= HEAL_AT };
    for (let f = 0; f < countForges(LEVELS[i]); f += 1) {
      if (plan.includes(used)) pending += 1;
      const advanced = pending > 0 && hasAdvancedOption(hero, opts);
      const options = upgradeOptions(hero, rng, 3, opts, { advanced });
      if (advanced && options.some((o) => isAdvanced(o.kind))) pending -= 1;
      if (options.length) applyUpgrade(hero, options.sort((a, b) => score(b) - score(a))[0]);
      used += 1;
    }
  }
  return hero.upgrades;
}

// ——— 战斗 ———

/** 主角开战时的心阵：按比例随机去掉一些红心。 */
function heroMatrix(rng, start) {
  const m = filledMatrix(level.hero.rows, level.hero.cols);
  let remove = Math.round(level.hero.rows * level.hero.cols * (1 - start));
  while (remove > 0) {
    const r = Math.floor(rng() * m.length);
    const c = Math.floor(rng() * m[0].length);
    if (m[r][c] > EMPTY) {
      m[r][c] = EMPTY;
      remove -= 1;
    }
  }
  return m;
}

function bestHeal(state) {
  let best = null;
  for (let r = -1; r <= state.heroMatrix.length; r += 1)
    for (let c = -1; c <= state.heroMatrix[0].length; c += 1) {
      const heals = resolveHeal(state.heroMatrix, POTION.shape, r, c);
      if (!best || heals.length > best.n) best = { r, c, n: heals.length };
    }
  return best?.n ? best : null;
}

/** 这件武器能切换出的所有朝向与长短。 */
function orientations(state, slot) {
  if (slot.kind !== "weapon") return [null];
  const up = state.upgrades[slot.id] ?? {};
  const list = [];
  for (const rot of up.rotate ? [0, 1, 2, 3] : [0])
    for (const flip of up.mirror ? [false, true] : [false])
      for (const ext of up.giant ? [0, 1, 2] : up.extend ? [0, 1] : [0]) list.push({ rot, flip, ext });
  return list;
}

function heroTurn(state) {
  const intent = state.intent;
  if (intent?.kind === "attack" && intent.shape.size >= 5 && state.shieldCd === 0 && !state.shieldUp && !state.bonus) heroShield(state);
  const { hearts, slots } = countHearts(state.heroMatrix);
  if (!state.bonus && state.potions > 0 && hearts < slots * 0.4) {
    const spot = bestHeal(state);
    if (spot && heroHeal(state, spot.r, spot.c).ok) return;
  }
  let best = null;
  for (const slot of state.weapons) {
    if (slotBlocked(state, slot)) continue;
    const saved = slot.orient;
    for (const orient of orientations(state, slot)) {
      if (orient) slot.orient = orient;
      const shape = slotShape(state, slot);
      for (const p of rankPlacements(state.monsterMatrix, shape, { pierce: slotPierce(state, slot) }).slice(0, 30)) {
        const outcome = comboOutcome(state, shape, p.r, p.c, slot.id);
        const broken = p.hits.filter((h) => h.after === EMPTY || h.after === VOID).length;
        let value = p.damage + (outcome === "link" ? 1.2 : outcome === "start" ? 0.3 : 0);
        if (canInterrupt(state, slot, broken)) value += 6;
        if (slot.kind === "skill") value -= 1.5;
        if (!best || value > best.value) best = { value, slot, orient, r: p.r, c: p.c };
      }
    }
    slot.orient = saved;
  }
  if (!best) {
    state.phase = "monster";
    return;
  }
  if (best.orient) best.slot.orient = best.orient;
  const res = heroAttack(state, best.slot.id, best.r, best.c);
  if (!res.ok) throw new Error(res.reason);
}

function fight(def, seed, { start, potions, upgrades }) {
  const rng = createRng(seed);
  const ups = upgrades === "max" ? devLoadout().upgrades : upgrades === "earned" ? earnedUpgrades(createRng(seed * 31 + 7)) : {};
  const state = createCombat({
    hero: { matrix: heroMatrix(rng, start), weapons: owned, equipped, potions, skills, equippedSkills, upgrades: ups },
    monster: { def, matrix: heartsAt(def, 2) },
    heroFirst: true,
    rng,
  });
  let guard = 0;
  while (!["won", "lost", "fled"].includes(state.phase) && guard++ < 600) {
    if (state.phase === "hero") heroTurn(state);
    else monsterTurn(state);
  }
  return { won: state.phase === "won", rounds: state.round, left: countHearts(state.heroMatrix).hearts, taken: state.stats.taken };
}

/** 跑 n 局，返回胜率等统计。 */
export function simulate(def, n, options) {
  let wins = 0, rounds = 0, left = 0, taken = 0;
  for (let i = 0; i < n; i += 1) {
    const r = fight(def, i * 7919 + 13, options);
    if (r.won) (wins += 1), (left += r.left);
    rounds += r.rounds;
    taken += r.taken;
  }
  return { win: Math.round((wins / n) * 100), rounds: +(rounds / n).toFixed(1), taken: +(taken / n).toFixed(1), left: +(wins ? left / wins : 0).toFixed(1) };
}

export { earnedUpgrades };

if (import.meta.url === `file://${process.argv[1]}`) {
  const N = Number(process.argv[2] ?? 300);
  const START = Number(process.argv[3] ?? 0.85);
  const POTIONS = Number(process.argv[4] ?? 3);
  console.log(`主角 ${level.hero.rows}×${level.hero.cols}，开战红心 ${Math.round(START * 100)}%，药水 ${POTIONS}；出战 ${equipped.join("、")}；技能 ${equippedSkills.join("、")}；${N} 局`);
  for (const [label, upgrades] of [["零强化", "none"], ["实际攒下来", "earned"], ["满强化", "max"]]) {
    const r = simulate(MONSTERS.king, N, { start: START, potions: POTIONS, upgrades });
    console.log(`${label.padEnd(8)} 胜率 ${String(r.win).padStart(3)}%  平均回合 ${String(r.rounds).padStart(5)}  平均失去红心 ${String(r.taken).padStart(5)}  获胜时剩余红心 ${String(r.left).padStart(5)}`);
  }
}
