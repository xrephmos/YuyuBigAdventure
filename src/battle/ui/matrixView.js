import { heartSvg } from "./icons.js";
import { VOID, EMPTY, ARMOR, footprint } from "../logic/shapes.js";

/**
 * 可交互的红心矩阵。四周有一圈“界外格”，让形状的锚点也能放到矩阵外面——形状只需覆盖到对应区域即可，不设边界。
 * 武器够得到的那一圈界外格和心阵里的空位一样画成虚线格，提示攻击可以有一部分落在心阵之外。
 */
export class MatrixView {
  constructor(el, { margin = 2, maxSize = 360, side = "enemy", box = null, minCell = 22 } = {}) {
    this.minCell = minCell;
    this.el = el;
    // box：给定外框时进入“铺满”模式，矩阵在框内居中，四周的界外格一直铺到填满外框。
    this.box = box;
    // margin 可以是一个数，也可以分别指定四边：{ top, bottom, left, right }。
    this.margin =
      typeof margin === "number" ? { top: margin, bottom: margin, left: margin, right: margin } : margin;
    this.maxSize = maxSize;
    this.side = side;
    this.matrix = null;
    this.cells = new Map();
    this.el.classList.add("matrix", `matrix-${side}`);
    this.onHover = null;
    this.onPick = null;
    this.onLeave = null;
    // 触屏第一次点下的格子（"r,c"）：再点同一格才算确认。onArm 在第一次点下时回调，界面可以提示“再点一次”。
    this.armedKey = null;
    this.onArm = null;

    this.el.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      const cell = e.target.closest?.(".cell");
      if (!cell || !this.onHover) return;
      this.onHover(Number(cell.dataset.r), Number(cell.dataset.c));
    });
    // 手指抬起后浏览器会立刻补发 pointerleave，不能因此把刚显示的预览清掉。
    this.el.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") this.onLeave?.();
    });
    this.el.addEventListener("pointerup", (e) => {
      const cell = e.target.closest?.(".cell");
      if (!cell || !this.onPick) return;
      const r = Number(cell.dataset.r);
      const c = Number(cell.dataset.c);
      // 鼠标有悬停预览，一点就出手；触屏、触控笔没有悬停：第一下只预览范围，再点同一格才确认。
      if (e.pointerType !== "mouse") {
        const k = `${r},${c}`;
        if (this.armedKey !== k) {
          this.onHover?.(r, c);
          this.armedKey = k;
          this.el.classList.add("armed");
          this.onArm?.(r, c);
          return;
        }
        this.disarm();
      }
      this.onPick(r, c);
    });
  }

  /** 取消“已点过一次”的状态：预览消失、换武器、心阵变化之后都要重新点两下。 */
  disarm() {
    this.armedKey = null;
    this.el.classList.remove("armed");
  }

  /** 外框尺寸变了之后按新尺寸重建网格。 */
  relayout() {
    const matrix = this.matrix;
    this.matrix = null;
    this.set(matrix);
  }

  set(matrix) {
    const rows = matrix.length;
    const cols = matrix[0].length;
    const sameShape = this.matrix && this.matrix.length === rows && this.matrix[0].length === cols;
    this.matrix = matrix;
    if (!sameShape) this.build(rows, cols);
    for (let r = 0; r < rows; r += 1)
      for (let c = 0; c < cols; c += 1) this.paint(r, c, matrix[r][c]);
    // 格子可能刚被重建（换尺寸、重排），被抹去的 × 要重新画上。
    this.markDoomed(this.doomed);
  }

  /** 铺满模式下，红心加上武器够得到的圈数能完整放下时的最大格子边长。 */
  fitSize(rows, cols) {
    const GAP = 3;
    const { top, bottom, left, right } = this.margin;
    const needV = Math.max(top, bottom);
    const needH = Math.max(left, right);
    const fit = (avail, n) => Math.floor((avail + GAP) / n - GAP);
    return Math.max(this.minCell, Math.min(92, fit(this.box.clientHeight, rows + needV * 2), fit(this.box.clientWidth, cols + needH * 2)));
  }

  build(rows, cols) {
    const GAP = 3;
    let { top, bottom, left, right } = this.margin;
    // 武器够得到的那几圈界外格画成虚线格（near），再往外的只是填满外框的透明格。
    let near = { top, bottom, left, right };
    let size;
    if (this.box) {
      // 先保证红心加上武器够得到的圈数能完整放下（上下、左右按较大的一侧对称留），再用界外格铺满外框。
      // fixedSize：战斗窗口让两块心阵共用同一个格子边长，左右看起来对齐。
      const w = this.box.clientWidth;
      const h = this.box.clientHeight;
      const needV = Math.max(top, bottom);
      const needH = Math.max(left, right);
      size = Math.min(this.fixedSize ?? Infinity, this.fitSize(rows, cols));
      const ringV = Math.max(needV, Math.ceil((h / (size + GAP) - rows) / 2) + 1);
      const ringH = Math.max(needH, Math.ceil((w / (size + GAP) - cols) / 2) + 1);
      near = { top: needV, bottom: needV, left: needH, right: needH };
      top = bottom = ringV;
      left = right = ringH;
    } else {
      const n = Math.max(rows + top + bottom, cols + left + right, 5);
      size = Math.max(24, Math.min(92, Math.floor((this.maxSize - (n - 1) * 4) / n)));
    }
    const totalR = rows + top + bottom;
    const totalC = cols + left + right;
    this.el.style.setProperty("--cell", `${size}px`);
    this.el.style.gap = `${this.box ? GAP : 4}px`;
    this.el.style.gridTemplateColumns = `repeat(${totalC}, ${size}px)`;
    this.el.style.gridTemplateRows = `repeat(${totalR}, ${size}px)`;
    this.el.innerHTML = "";
    this.cells.clear();
    for (let r = -top; r < rows + bottom; r += 1)
      for (let c = -left; c < cols + right; c += 1) {
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.r = r;
        cell.dataset.c = c;
        const inside = r >= 0 && c >= 0 && r < rows && c < cols;
        if (!inside) cell.classList.add("outside");
        if (!inside && r >= -near.top && r < rows + near.bottom && c >= -near.left && c < cols + near.right) cell.classList.add("near");
        else cell.style.setProperty("--i", r * cols + c);
        this.el.appendChild(cell);
        this.cells.set(`${r},${c}`, cell);
      }
  }

  paint(r, c, value) {
    const cell = this.cells.get(`${r},${c}`);
    if (!cell) return;
    const state = value === VOID ? "void" : value === EMPTY ? "empty" : value >= ARMOR ? "armor" : "heart";
    if (cell.dataset.state === state) return;
    cell.dataset.state = state;
    cell.classList.remove("void", "empty", "heart", "armor");
    cell.classList.add("slot", state);
    cell.innerHTML =
      state === "void"
        ? ""
        : state === "empty"
          ? heartSvg("heart-empty")
          : state === "armor"
            ? heartSvg("armor")
            : heartSvg("heart");
  }

  clearPreview() {
    this.disarm();
    for (const cell of this.cells.values())
      cell.classList.remove("pv", "pv-hit", "pv-crack", "pv-heal", "pv-anchor", "pv-miss", "pv-off");
  }

  /** 预览形状：整块足迹 + 会被命中/治疗的格子。 */
  preview(shape, r, c, changes, { tone = "hit", valid = true } = {}) {
    this.clearPreview();
    this.el.classList.toggle("pv-invalid", !valid);
    const changed = new Map(changes.map((h) => [`${h.r},${h.c}`, h]));
    for (const [fr, fc] of footprint(shape, r, c)) {
      const cell = this.cells.get(`${fr},${fc}`);
      if (!cell) continue;
      cell.classList.add("pv");
      if (cell.classList.contains("outside")) cell.classList.add("pv-off");
      const change = changed.get(`${fr},${fc}`);
      if (!change) {
        if (!cell.classList.contains("outside")) cell.classList.add("pv-miss");
        continue;
      }
      if (tone === "heal") cell.classList.add("pv-heal");
      else cell.classList.add(change.after > 0 ? "pv-crack" : "pv-hit");
    }
    this.cells.get(`${r},${c}`)?.classList.add("pv-anchor");
  }

  /** 怪物瞄准区域（持续显示在主角矩阵上）。 */
  /** 标出上一击覆盖的格子，提示下一击要挨着它打。 */
  markLast(cells) {
    for (const cell of this.el.querySelectorAll(".cell.last-hit")) cell.classList.remove("last-hit");
    for (const [r, c] of cells ?? []) this.cells.get(`${r},${c}`)?.classList.add("last-hit");
  }

  /**
   * 标出怪物下一招的瞄准范围。spared 为招架保住的那一格 [r, c]：
   * 它不画成黑色的“会被打掉”，而是画成蓝色描边的“保住了”。
   */
  markAim(shape, aim, spared = null) {
    for (const cell of this.cells.values()) cell.classList.remove("aim", "aim-off", "aim-parried");
    if (!shape || !aim) return;
    for (const [r, c] of footprint(shape, aim.r, aim.c)) {
      const cell = this.cells.get(`${r},${c}`);
      if (!cell) continue;
      const saved = spared && spared[0] === r && spared[1] === c;
      cell.classList.add(cell.classList.contains("outside") ? "aim-off" : saved ? "aim-parried" : "aim");
    }
  }

  /** 播放格子变化动画，然后写入新矩阵。 */
  /**
   * 出手瞬间：武器形状盖住的格子先闪一下，再碎。heavy 时闪得更重。
   * foe：怪物打在主角身上，闪成红色。
   */
  strike(cells, { heavy = false, foe = false } = {}) {
    if (!cells?.length) return;
    for (const [r, c] of cells) {
      const cell = this.cells.get(`${r},${c}`);
      if (!cell) continue;
      cell.classList.remove("strike", "strike-heavy", "strike-foe");
      void cell.offsetWidth;
      cell.classList.add(heavy ? "strike-heavy" : "strike");
      if (foe) cell.classList.add("strike-foe");
      setTimeout(() => cell.classList.remove("strike", "strike-heavy", "strike-foe"), 420);
    }
    if (heavy) {
      // 冲击波：以形状中心为圆心扩散的一圈方框。
      const pts = cells.map(([r, c]) => this.cells.get(`${r},${c}`)).filter(Boolean);
      if (!pts.length) return;
      const box = this.el.getBoundingClientRect();
      const rects = pts.map((p) => p.getBoundingClientRect());
      const cx = rects.reduce((s, b) => s + b.left + b.width / 2, 0) / rects.length - box.left;
      const cy = rects.reduce((s, b) => s + b.top + b.height / 2, 0) / rects.length - box.top;
      const wave = document.createElement("i");
      wave.className = "shockwave";
      wave.style.left = `${cx}px`;
      wave.style.top = `${cy}px`;
      this.el.appendChild(wave);
      setTimeout(() => wave.remove(), 650);
    }
  }

  /** 标出被死灭抹去的格子：格子中间一个黑色的 ×，表示这里曾经有过心。 */
  markDoomed(cells) {
    // 记住这份名单：之后重建格子时由 set() 重新标上。
    this.doomed = cells ?? [];
    for (const cell of this.el.querySelectorAll(".cell.doomed")) cell.classList.remove("doomed");
    for (const [r, c] of cells ?? []) this.cells.get(`${r},${c}`)?.classList.add("doomed");
  }

  /** 标出怪物下一招要补回的格子（回血）。 */
  markHeal(cells) {
    for (const cell of this.el.querySelectorAll(".cell.heal-plan")) cell.classList.remove("heal-plan");
    for (const [r, c] of cells ?? []) this.cells.get(`${r},${c}`)?.classList.add("heal-plan");
  }

  /**
   * 红心一颗颗填进空框：每格叠一颗红心，按顺序错开弹出，全部填完再写入新矩阵。
   */
  async fillHearts(changes, nextMatrix, step = 38) {
    changes.forEach((ch, i) => {
      const cell = this.cells.get(`${ch.r},${ch.c}`);
      if (!cell) return;
      const heart = document.createElement("span");
      heart.className = "fill-heart";
      heart.style.setProperty("--d", `${i * step}ms`);
      heart.innerHTML = heartSvg(ch.after >= ARMOR ? "armor" : "heart");
      cell.appendChild(heart);
    });
    await new Promise((r) => setTimeout(r, 460 + changes.length * step));
    this.set(nextMatrix);
  }

  async animate(changes, kind, nextMatrix, { heavy = false } = {}) {
    const cls = { hit: "breaking", crack: "cracking", heal: "healing", armor: "armoring" };
    for (const [i, ch] of changes.entries()) {
      const cell = this.cells.get(`${ch.r},${ch.c}`);
      if (!cell) continue;
      const k = kind === "hit" && ch.after > 0 ? "crack" : kind;
      cell.style.setProperty("--d", `${i * 45}ms`);
      cell.classList.add(cls[k]);
      if (kind === "hit") this.spawnShards(cell, heavy);
    }
    await new Promise((r) => setTimeout(r, 420 + changes.length * 45));
    for (const ch of changes) {
      const cell = this.cells.get(`${ch.r},${ch.c}`);
      cell?.classList.remove("breaking", "cracking", "healing", "armoring");
      cell?.style.removeProperty("--d");
    }
    this.set(nextMatrix);
  }

  spawnShards(cell, heavy = false) {
    const n = heavy ? 9 : 6;
    const reach = heavy ? 34 : 20;
    for (let i = 0; i < n; i += 1) {
      const shard = document.createElement("i");
      // 碎片是像素方块：大多是红心的红，夹着几块纸白。
      shard.className = `shard ${i % 3 === 2 ? "paper" : ""} ${heavy && i % 4 === 0 ? "big" : ""}`;
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      shard.style.setProperty("--x", `${Math.cos(a) * (reach + Math.random() * reach * 0.8)}px`);
      shard.style.setProperty("--y", `${Math.sin(a) * (reach + Math.random() * reach * 0.8) - 12}px`);
      shard.style.setProperty("--r", `${Math.round(Math.random() * 360)}deg`);
      cell.appendChild(shard);
      setTimeout(() => shard.remove(), 700);
    }
  }

  shake(heavy = false) {
    this.el.classList.remove("shaking", "shaking-heavy");
    void this.el.offsetWidth;
    this.el.classList.add(heavy ? "shaking-heavy" : "shaking");
  }
}
