/**
 * 暗王战模拟：同一套主角配置打很多局，比较「只有一阶段」和「带二阶段」的胜率、回合数和剩余红心。
 * 只模拟暗王这一场（不含之前的王后与小兵），用来调二阶段的心阵和招式。
 *
 *   node tools/boss-sim.mjs [局数] [开战时的红心比例 0~1] [药水数]
 *
 * 模拟玩家的打法（比随手乱打聪明，但不做长远规划）：
 *   - 怪物下一招打得多（5 格以上）且防御可用时先防御；
 *   - 红心低于四成、手里有药水时喝药，补在恢复最多的位置；
 *   - 否则在所有可用的招式与落点里挑「伤害 + 连击 + 打断」得分最高的一个。
 */
import { createCombat, createRng, heroAttack, heroShield, heroHeal, monsterTurn, slotBlocked, slotShape, slotPierce, slotDef, comboOutcome, canInterrupt } from "../src/battle/logic/combat.js";
import { MONSTERS, heartsAt } from "../src/battle/data/monsters.js";
import { LEVELS, weaponsForLevel, skillsForLevel } from "../src/battle/data/levels.js";
import { STARTING_WEAPONS, POTION } from "../src/battle/data/weapons.js";
import { SKILLS } from "../src/battle/data/skills.js";
import { filledMatrix, rankPlacements, countHearts, resolveHeal, VOID, EMPTY } from "../src/battle/logic/shapes.js";

const N = Number(process.argv[2] ?? 300);
const START = Number(process.argv[3] ?? 0.85);
const POTIONS = Number(process.argv[4] ?? 2);

const index = LEVELS.findIndex((l) => l.key === "checkmate");
const level = LEVELS[index];
const owned = weaponsForLevel(index, STARTING_WEAPONS);
// 出战武器：轻、中、重都带上，按章节武器槽数截断。
const PRIORITY = ["dagger", "hook", "hammer", "slash", "cross", "awl", "scythe", "spear"];
const equipped = PRIORITY.filter((id) => owned.includes(id)).slice(0, level.slots);
const skills = skillsForLevel(index, SKILLS);
const equippedSkills = Object.keys(skills).slice(-3);

/** 主角开战时的心阵：按比例从右下角往回去掉一些红心。 */
function heroMatrix(rng) {
  const m = filledMatrix(level.hero.rows, level.hero.cols);
  const total = level.hero.rows * level.hero.cols;
  let remove = Math.round(total * (1 - START));
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
    const shape = slotShape(state, slot);
    for (const p of rankPlacements(state.monsterMatrix, shape, { pierce: slotPierce(state, slot) }).slice(0, 30)) {
      const outcome = comboOutcome(state, shape, p.r, p.c, slot.id);
      const broken = p.hits.filter((h) => h.after === EMPTY || h.after === VOID).length;
      let score = p.damage + (outcome === "link" ? 1.2 : outcome === "start" ? 0.3 : 0);
      if (canInterrupt(state, slot, broken)) score += 6;
      if (slot.kind === "skill") score -= 1.5;
      if (!best || score > best.score) best = { score, id: slot.id, r: p.r, c: p.c };
    }
  }
  if (!best) {
    state.phase = "monster";
    return;
  }
  const res = heroAttack(state, best.id, best.r, best.c);
  if (!res.ok) throw new Error(res.reason);
}

function fight(def, seed) {
  const rng = createRng(seed);
  const state = createCombat({
    hero: { matrix: heroMatrix(rng), weapons: owned, equipped, potions: POTIONS, skills, equippedSkills },
    monster: { def, matrix: heartsAt(def, 2) },
    heroFirst: true,
    rng,
  });
  let guard = 0;
  let rebornAt = null;
  while (!["won", "lost", "fled"].includes(state.phase) && guard++ < 600) {
    if (state.phase === "hero") heroTurn(state);
    else monsterTurn(state);
    if (state.reborn && rebornAt === null) rebornAt = state.round;
  }
  return { won: state.phase === "won", rounds: state.round, rebornAt, left: countHearts(state.heroMatrix).hearts, taken: state.stats.taken };
}

function report(label, def) {
  let wins = 0, rounds = 0, left = 0, taken = 0, reborn = 0;
  for (let i = 0; i < N; i += 1) {
    const r = fight(def, i * 7919 + 13);
    if (r.won) wins += 1, (left += r.left);
    rounds += r.rounds;
    taken += r.taken;
    if (r.rebornAt !== null) reborn += 1;
  }
  console.log(
    `${label.padEnd(10)} 胜率 ${((wins / N) * 100).toFixed(0).padStart(3)}%  平均回合 ${(rounds / N).toFixed(1).padStart(5)}  平均失去红心 ${(taken / N).toFixed(1).padStart(5)}  获胜时剩余红心 ${(wins ? left / wins : 0).toFixed(1).padStart(5)}${def.rebirth ? `  进入二阶段 ${((reborn / N) * 100).toFixed(0)}%` : ""}`,
  );
}

console.log(`主角 ${level.hero.rows}×${level.hero.cols}，开战红心 ${Math.round(START * 100)}%，药水 ${POTIONS}；出战 ${equipped.join("、")}；技能 ${equippedSkills.join("、")}；${N} 局`);
const king = MONSTERS.king;
report("只有一阶段", { ...king, rebirth: undefined });
report("带二阶段", king);
