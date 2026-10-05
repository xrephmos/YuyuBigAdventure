/**
 * 整个战役的平衡模拟：每一章按当时拥有的武器、技能、武器槽、已解锁的机制和攒下来的强化配好主角，
 * 依次打完这一章所有的怪物（红心与药水在场与场之间延续，掉落的药水会捡起来），统计每章的失败率等数据。
 *
 *   node tools/campaign-sim.mjs [每章局数]
 *
 * 两种玩家：
 *   - 认真：会防御、该喝药时喝药、找连击和打断、切换旋转 / 镜像 / 延长 / 巨化；
 *   - 随手：只挑伤害最大的落点，不防御，红心不到四分之一才喝药。
 * 三档强化：零强化 / 按铁砧实际攒下来 / 满强化（开发者模式，作为上限参考）。
 *
 * 怪物按离起点的远近依次遭遇；另外算一档「可绕就绕」：不在必经之路上、不追人、不掉药水的怪物不打。
 * 简化：宝箱里的武器从开局就算在手里；护甲片不计。模拟玩家只看眼前一步，
 * 突刺、定身钉这类靠"多一招 / 让对方停一回合"取胜的技能几乎不会用，所以不拿它来评判技能强弱。
 *
 * 第一次跑出来的问题：城堡单挑要失去主角一半以上的红心，城堡之墙一章近一半打不完、终章 85% 倒在暗王面前；
 * 改成筑墙 1、冲撞 3 格之后，城堡与王后、主教同档，终章（认真玩家、攒下来的强化）约四成打不完。
 */
import {
  createCombat,
  createRng,
  heroAttack,
  heroShield,
  heroHeal,
  heroWait,
  monsterTurn,
  slotBlocked,
  slotShape,
  slotPierce,
  slotDef,
  comboOutcome,
  canInterrupt,
  energyCost,
  skillCharges,
} from "../src/battle/logic/combat.js";
import { MONSTERS, variantsAt } from "../src/battle/data/monsters.js";
import { LEVELS, weaponsForLevel, skillsForLevel } from "../src/battle/data/levels.js";
import { STARTING_WEAPONS, POTION, WEAPONS } from "../src/battle/data/weapons.js";
import { SKILLS } from "../src/battle/data/skills.js";
import { featuresAt } from "../src/battle/data/features.js";
import { filledMatrix, rankPlacements, countHearts, resolveHeal, applyChanges, VOID, EMPTY } from "../src/battle/logic/shapes.js";
import { upgradeOptions, applyUpgrade, planAdvancedForges, hasAdvancedOption, isAdvanced, SKILL_SLOTS } from "../src/battle/logic/arsenal.js";
import { devLoadout } from "../src/battle/logic/devMode.js";

// ——— 配装 ———

/** 出战顺序：轻、中、重都要有；越靠前越优先上阵。 */
const PRIORITY = ["dagger", "hook", "hammer", "slash", "cross", "awl", "scythe", "spear"];

function ownedAt(i) {
  const list = weaponsForLevel(i, STARTING_WEAPONS);
  const chest = LEVELS[i].chest;
  return chest && !list.includes(chest) ? [...list, chest] : list;
}

const countForges = (lvl) => lvl.map.join("").split("U").length - 1;
const firstChapter = (test) => LEVELS.findIndex((l) => l.monsters.some((m) => test(MONSTERS[m.type])));
const ARMOR_AT = firstChapter((def) => def.armored);
const CHARGE_AT = firstChapter((def) => def.pattern.some((p) => p.kind === "charge"));
const HEAL_AT = firstChapter((def) => def.pattern.some((p) => p.kind === "heal"));
const PREFERENCE = { giant: 9, quake: 8, chain: 8, doom: 8, line: 8, extend: 7, leech: 6, parry: 6, precise: 5, pierce: 4, stagger: 4, rotate: 2, mirror: 2 };

/** 从第 0 章走到第 upto 章（含这一章的铁砧）一路攒下来的强化。 */
function earnedUpgrades(upto, rng) {
  const total = LEVELS.reduce((n, l) => n + countForges(l), 0);
  const plan = planAdvancedForges({ total }, rng);
  const hero = { weapons: [], upgrades: {} };
  let used = 0;
  let pending = 0;
  for (let i = 0; i <= upto; i += 1) {
    hero.weapons = ownedAt(i);
    const equipped = PRIORITY.filter((id) => hero.weapons.includes(id)).slice(0, LEVELS[i].slots);
    const score = (o) => (PREFERENCE[o.kind] ?? 1) + (isAdvanced(o.kind) ? 10 : 0) + (equipped.includes(o.weapon) ? 3 : 0);
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

// ——— 出招 ———

function bestHeal(state) {
  let best = null;
  for (let r = -1; r <= state.heroMatrix.length; r += 1)
    for (let c = -1; c <= state.heroMatrix[0].length; c += 1) {
      const heals = resolveHeal(state.heroMatrix, POTION.shape, r, c);
      if (!best || heals.length > best.n) best = { r, c, n: heals.length };
    }
  return best?.n ? best : null;
}

function orientations(state, slot, careful) {
  if (slot.kind !== "weapon" || !careful) return [null];
  const up = state.upgrades[slot.id] ?? {};
  const list = [];
  for (const rot of up.rotate ? [0, 1, 2, 3] : [0])
    for (const flip of up.mirror ? [false, true] : [false])
      for (const ext of up.giant ? [0, 1, 2] : up.extend ? [0, 1] : [0]) list.push({ rot, flip, ext });
  return list;
}

function heroTurn(state, careful, tally) {
  const intent = state.intent;
  if (careful && intent?.kind === "attack" && intent.shape.size >= 5 && state.shieldCd === 0 && !state.shieldUp && !state.bonus && heroShield(state).ok) tally.shields += 1;
  const { hearts, slots } = countHearts(state.heroMatrix);
  if (!state.bonus && state.potions > 0 && hearts < slots * (careful ? 0.4 : 0.25)) {
    const spot = bestHeal(state);
    if (spot && heroHeal(state, spot.r, spot.c).ok) {
      tally.potions += 1;
      return;
    }
  }
  let best = null;
  for (const slot of state.weapons) {
    if (slotBlocked(state, slot)) continue;
    const saved = slot.orient;
    for (const orient of orientations(state, slot, careful)) {
      if (orient) slot.orient = orient;
      const shape = slotShape(state, slot);
      for (const p of rankPlacements(state.monsterMatrix, shape, { pierce: slotPierce(state, slot) }).slice(0, careful ? 30 : 1)) {
        let value = p.damage;
        if (careful) {
          const outcome = comboOutcome(state, shape, p.r, p.c, slot.id);
          const broken = p.hits.filter((h) => h.after === EMPTY || h.after === VOID).length;
          value += outcome === "link" ? 1.2 : outcome === "start" ? 0.3 : 0;
          if (canInterrupt(state, slot, broken)) value += 6;
          if (slot.kind === "skill") value -= 1.5;
        } else if (slot.kind === "skill") value -= 0.5;
        if (!best || value > best.value) best = { value, slot, orient, r: p.r, c: p.c };
      }
    }
    slot.orient = saved;
  }
  if (!best) {
    if (!heroWait(state).ok) state.phase = "monster";
    return;
  }
  if (best.orient) best.slot.orient = best.orient;
  const cost = energyCost(best.slot);
  const res = heroAttack(state, best.slot.id, best.r, best.c);
  if (!res.ok) throw new Error(res.reason);
  const key = best.slot.kind === "skill" ? `技能·${SKILLS[best.slot.id].name}` : WEAPONS[best.slot.id].name;
  tally.use[key] = (tally.use[key] ?? 0) + res.events.find((e) => e.type === "hero-attack").hits.length;
  tally.energySpent += cost;
  if (res.events.some((e) => e.type === "bonus" && e.reason === "chase")) tally.chases += 1;
  if (res.events.some((e) => e.type === "interrupt")) tally.interrupts += 1;
}

// ——— 哪些怪物可以绕开 ———

/** 不在必经之路上、也不会追人的怪物：堵上它那一格，起点照样走得到出口。掉药水的不绕（值得打）。 */
function optionalMonsters(level) {
  const grid = level.map.map((line) => [...line.replace(/\s+/g, "")]);
  const find = (ch) => grid.flatMap((row, r) => row.map((x, c) => (x === ch ? [r, c] : null))).filter(Boolean)[0];
  const start = find("S");
  const exit = find("E");
  const reachable = (blocked) => {
    const seen = new Set([start.join()]);
    const queue = [start];
    while (queue.length) {
      const [r, c] = queue.shift();
      if (r === exit[0] && c === exit[1]) return true;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = r + dr, nc = c + dc, k = `${nr},${nc}`;
        if (!grid[nr]?.[nc] || /[bcidtw]/.test(grid[nr][nc]) || blocked.has(k) || seen.has(k)) continue;
        seen.add(k);
        queue.push([nr, nc]);
      }
    }
    return false;
  };
  const set = new Set();
  for (const m of level.monsters) {
    if (m.ai === "chase" || m.drop || MONSTERS[m.type].boss) continue;
    const blocked = new Set([...set].map((o) => o.at.join()));
    blocked.add(m.at.join());
    if (reachable(blocked)) set.add(m);
  }
  return set;
}

// ——— 一章 ———

function playChapter(i, seed, { careful, upgrades, skip = false, equip = null }) {
  const level = LEVELS[i];
  const optional = skip ? optionalMonsters(level) : new Set();
  const rng = createRng(seed);
  const features = featuresAt(i);
  const dev = upgrades === "max" ? devLoadout() : null;
  const owned = dev ? dev.weapons.filter((id) => ownedAt(LEVELS.length - 1).includes(id)) : ownedAt(i);
  const equipped = equip ? equip.filter((id) => owned.includes(id)) : PRIORITY.filter((id) => owned.includes(id)).slice(0, level.slots);
  const skills = skillsForLevel(i, SKILLS);
  const equippedSkills = Object.keys(skills).slice(-SKILL_SLOTS);
  const ups = upgrades === "max" ? dev.upgrades : upgrades === "earned" ? earnedUpgrades(i, createRng(seed * 31 + 7)) : {};
  let matrix = filledMatrix(level.hero.rows, level.hero.cols);
  // 地图上摆着的药水（P）也算进来：认真玩家会一路捡起。
  let potions = (level.potions ?? 0) + level.map.join("").split("P").length - 1;
  let charges = { ...skills };
  const tally = { rounds_: {}, lost: {}, use: {}, chases: 0, interrupts: 0, shields: 0, potions: 0, energySpent: 0, rounds: 0, fights: 0, bestCombo: 0 };
  const start = countHearts(matrix).slots;
  // 按离起点的远近依次遭遇（终章先过两座城堡，最后才是暗王）。
  const startRow = level.map.findIndex((line) => line.includes("S"));
  const startCol = level.map[startRow].replace(/\s+/g, "").indexOf("S");
  const order = [...level.monsters].sort((a, b) => Math.abs(a.at[0] - startRow) + Math.abs(a.at[1] - startCol) - (Math.abs(b.at[0] - startRow) + Math.abs(b.at[1] - startCol)));
  for (const spec of order) {
    if (optional.has(spec)) continue;
    const def = MONSTERS[spec.type];
    const variants = variantsAt(def, level.rank ?? 0);
    // 战斗之间在棋盘上喝药：红心不到一半时补到一半以上。
    while (features.has("potion") && potions > 0 && countHearts(matrix).hearts < start * 0.5) {
      const probe = { heroMatrix: matrix };
      const spot = bestHeal(probe);
      if (!spot) break;
      matrix = applyChanges(matrix, resolveHeal(matrix, POTION.shape, spot.r, spot.c));
      potions -= 1;
      tally.potions += 1;
    }
    const state = createCombat({
      hero: { matrix, weapons: owned, equipped, potions, upgrades: ups, skills: charges, equippedSkills },
      monster: { def, matrix: variants[Math.floor(rng() * variants.length)] },
      // 会追击的怪物：随手玩家总被它先撞上；认真玩家会等它走近再先出手，只有关卡专门设下的贴脸埋伏（sight 1）躲不掉。
      heroFirst: spec.ai !== "chase" || (careful && spec.sight !== 1),
      rng,
      features,
    });
    let guard = 0;
    while (!["won", "lost", "fled"].includes(state.phase) && guard++ < 800) {
      if (state.phase === "hero") heroTurn(state, careful, tally);
      else monsterTurn(state);
    }
    tally.rounds += state.round;
    tally.fights += 1;
    tally.bestCombo = Math.max(tally.bestCombo, state.bestCombo);
    potions = state.potions;
    const lostKey = `${def.name}`;
    tally.lost[lostKey] = tally.lost[lostKey] ?? [];
    tally.lost[lostKey].push(state.stats.taken);
    (tally.rounds_[lostKey] = tally.rounds_[lostKey] ?? []).push(state.round);
    charges = { ...charges, ...skillCharges(state) };
    matrix = state.heroMatrix;
    if (state.phase !== "won") return { dead: true, tally, left: 0, start };
    if (spec.drop === "potion") potions += 1;
  }
  return { dead: false, tally, left: countHearts(matrix).hearts, start };
}

export function chapterStats(i, n, options) {
  let dead = 0, left = 0, rounds = 0, fights = 0, chases = 0, interrupts = 0, energy = 0, combo = 0;
  const use = {};
  const lost = {};
  const mrounds = {};
  for (let k = 0; k < n; k += 1) {
    const r = playChapter(i, k * 7919 + i * 131 + 17, options);
    if (r.dead) dead += 1;
    else left += r.left / r.start;
    rounds += r.tally.rounds;
    fights += r.tally.fights;
    chases += r.tally.chases;
    interrupts += r.tally.interrupts;
    energy += r.tally.energySpent;
    combo += r.tally.bestCombo;
    for (const [key, v] of Object.entries(r.tally.use)) use[key] = (use[key] ?? 0) + v;
    for (const [key, v] of Object.entries(r.tally.lost)) (lost[key] = lost[key] ?? []).push(...v);
    for (const [key, v] of Object.entries(r.tally.rounds_)) (mrounds[key] = mrounds[key] ?? []).push(...v);
  }
  const alive = n - dead;
  return {
    fail: Math.round((dead / n) * 100),
    hpLeft: alive ? Math.round((left / alive) * 100) : 0,
    roundsPerFight: +(rounds / Math.max(1, fights)).toFixed(1),
    chasesPerChapter: +(chases / n).toFixed(1),
    interruptsPerChapter: +(interrupts / n).toFixed(1),
    energyPerChapter: +(energy / n).toFixed(1),
    bestCombo: +(combo / n).toFixed(1),
    use,
    rounds: Object.fromEntries(Object.entries(mrounds).map(([k, v]) => [k, +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)])),
    lost: Object.fromEntries(Object.entries(lost).map(([k, v]) => [k, +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)])),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const N = Number(process.argv[2] ?? 100);
  const pct = (use) => {
    const total = Object.values(use).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(use)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k}${Math.round((v / total) * 100)}`)
      .join(" ");
  };
  const fmt = (r) => `败${String(r.fail).padStart(3)}% 剩${String(r.hpLeft).padStart(2)}%`;
  console.log(`每章 ${N} 局。败 = 这一章没走完的比例；剩 = 走完时剩下的红心比例。`);
  console.log("章节            随手·零强化·全打   认真·攒强化·全打   认真·攒强化·可绕就绕  认真·满强化   | 每场回合 追击 打断 最长连击 | 心数占比（认真·攒强化） | 每场失去红心");
  LEVELS.forEach((level, i) => {
    const casual = chapterStats(i, N, { careful: false, upgrades: "none" });
    const earned = chapterStats(i, N, { careful: true, upgrades: "earned" });
    const skip = chapterStats(i, N, { careful: true, upgrades: "earned", skip: true });
    const max = chapterStats(i, N, { careful: true, upgrades: "max" });
    const size = level.hero.rows * level.hero.cols;
    console.log(
      `${String(i).padStart(2)} ${level.name.padEnd(6, "　")} ${size}心`,
      fmt(casual).padEnd(14),
      fmt(earned).padEnd(14),
      fmt(skip).padEnd(14),
      fmt(max).padEnd(14),
      `| ${earned.roundsPerFight}回 追${earned.chasesPerChapter} 断${earned.interruptsPerChapter} 连${earned.bestCombo} |`,
      pct(earned.use),
      "|",
      Object.entries(earned.lost).map(([k, v]) => `${k}${v}`).join(" "),
    );
  });
}
