// =====================================================================
//  OMR — lecture simplifiée de partition imprimée (captures d'écran, photos nettes)
//  Tout se passe dans le navigateur, sans serveur.
//  Pipeline : niveaux de gris → binarisation → redressement → portées →
//  suppression des lignes → têtes de notes → hampes / crochets / ligatures →
//  points, altérations, armure, clé, silences, barres de mesure → texte.
// =====================================================================
(function (global) {
'use strict';

const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const PC = [0, 2, 4, 5, 7, 9, 11];
const NOMS_FR = { C: 'Do', D: 'Ré', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
const ORDRE_DIESES = 'FCGDAEB', ORDRE_BEMOLS = 'BEADGCF';

// ---------------------------------------------------------------------
//  Outils image
// ---------------------------------------------------------------------
function versGris(img) { // {width,height,data RGBA} -> {w,h,g}
  const w = img.width, h = img.height, d = img.data, g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    const a = d[j + 3] / 255; // fond transparent = blanc
    g[i] = Math.round((0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * a + 255 * (1 - a));
  }
  return { w, h, g };
}

function integrale(w, h, src) { // Float64 pour éviter les débordements
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) { s += src[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; }
  }
  return I;
}
function somme(I, w, x0, y0, x1, y1) { // [x0,x1) × [y0,y1), bornes déjà valides
  const W = w + 1;
  return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
}

function binariser(G, fen, K = 0.82) {
  const { w, h, g } = G, b = new Uint8Array(w * h);
  const I = integrale(w, h, g), r = fen >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const m = somme(I, w, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
      const v = g[y * w + x];
      b[y * w + x] = (v < 100 || (v < 225 && v < m * K)) ? 1 : 0;
    }
  }
  return b;
}

// Interligne (s) et épaisseur des lignes (t) par histogramme des plages verticales
function estimerInterligne(b, w, h) {
  const noir = new Array(64).fill(0), blanc = new Array(256).fill(0);
  const pas = Math.max(1, Math.floor(w / 300));
  for (let x = 0; x < w; x += pas) {
    let y = 0;
    while (y < h) {
      const v = b[y * w + x]; let n = 0;
      while (y < h && b[y * w + x] === v) { n++; y++; }
      if (v) { if (n < 64) noir[n]++; } else if (n < 256) blanc[n]++;
    }
  }
  let t = 1; for (let i = 1; i < 64; i++) if (noir[i] > noir[t]) t = i;
  let e = 3; for (let i = 3; i < 256; i++) if (blanc[i] > blanc[e]) e = i;
  return { s: e + t, t, blanc: e };
}

// Redressement : angle qui maximise la netteté de la projection horizontale
function estimerAngle(b, w, h) {
  const pas = Math.max(1, Math.floor(w / 500));
  let meilleur = 0, scoreMax = -1;
  for (let a = -5; a <= 5.0001; a += 0.25) {
    const t = Math.tan(a * Math.PI / 180), proj = new Float64Array(h + 2 * w);
    const off = w;
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += pas) if (b[y * w + x]) proj[Math.round(y + x * t) + off]++;
    let sc = 0; for (let i = 0; i < proj.length; i++) sc += proj[i] * proj[i];
    if (sc > scoreMax) { scoreMax = sc; meilleur = a; }
  }
  return meilleur;
}
function redimensionner(G, k) { // bilinéaire
  const w2 = Math.max(1, Math.round(G.w * k)), h2 = Math.max(1, Math.round(G.h * k)), g = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const ys = Math.min(G.h - 1.001, (y + 0.5) / k - 0.5), y0 = Math.max(0, Math.floor(ys)), fy = Math.max(0, ys - y0);
    for (let x = 0; x < w2; x++) {
      const xs = Math.min(G.w - 1.001, (x + 0.5) / k - 0.5), x0 = Math.max(0, Math.floor(xs)), fx = Math.max(0, xs - x0), i = y0 * G.w + x0;
      g[y * w2 + x] = (G.g[i] * (1 - fx) + G.g[i + 1] * fx) * (1 - fy) + (G.g[i + G.w] * (1 - fx) + G.g[i + G.w + 1] * fx) * fy;
    }
  }
  return { w: w2, h: h2, g };
}
function tourner(G, angleDeg) { // rotation autour du centre, bilinéaire, fond blanc
  const { w, h, g } = G, out = new Uint8Array(w * h).fill(255);
  const a = -angleDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xs = c * (x - cx) - s * (y - cy) + cx, ys = s * (x - cx) + c * (y - cy) + cy;
    const x0 = Math.floor(xs), y0 = Math.floor(ys);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
    const fx = xs - x0, fy = ys - y0, i = y0 * w + x0;
    out[y * w + x] = (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  }
  return { w, h, g: out };
}

// ---------------------------------------------------------------------
//  Portées
// ---------------------------------------------------------------------
function trouverPortees(b, w, h, s, t) {
  // score d'une ligne = plus longue suite de pixels noirs (tolère de petits trous)
  const score = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let best = 0, cur = 0, trou = 0;
    for (let x = 0; x < w; x++) {
      const v = b[y * w + x] || (y > 0 && b[(y - 1) * w + x]) || (y < h - 1 && b[(y + 1) * w + x]);
      if (v) { cur += 1 + trou; trou = 0; } else if (cur && trou < 2) trou++; else { cur = 0; trou = 0; }
      if (cur > best) best = cur;
    }
    score[y] = best;
  }
  let max = 0; for (let y = 0; y < h; y++) max = Math.max(max, score[y]);
  const seuil = Math.max(8 * s, max * 0.18);
  // groupes de rangées consécutives au-dessus du seuil ; épaisseur mesurée sur le cœur du groupe
  const lignes = [];
  let y = 0;
  while (y < h) {
    if (score[y] < seuil) { y++; continue; }
    let y2 = y; while (y2 + 1 < h && score[y2 + 1] >= seuil) y2++;
    let pic = 0; for (let k = y; k <= y2; k++) pic = Math.max(pic, score[k]);
    const rangs = []; for (let k = y; k <= y2; k++) { let n = 0; for (let x = 0; x < w; x++) n += b[k * w + x]; rangs.push([k, n]); }
    const nmax = Math.max(...rangs.map(r => r[1]));
    const coeur = rangs.filter(r => r[1] >= 0.5 * nmax);
    const tot = coeur.reduce((a, c) => a + c[1], 0);
    if (tot > 0) {
      const yc = coeur.reduce((a, c) => a + c[0] * c[1], 0) / tot;
      lignes.push({ y: yc, ep: coeur[coeur.length - 1][0] - coeur[0][0] + 1, long: pic });
    }
    y = y2 + 1;
  }
  const L = lignes.filter(l => l.ep <= Math.max(3, 2.5 * t + 1));
  // regroupe par 5 avec écarts réguliers (on tolère une ligne manquante, reconstruite)
  const portees = [];
  const pris = new Set();
  for (let i = 0; i < L.length; i++) {
    if (pris.has(i)) continue;
    let meilleur = null;
    for (let j = i + 1; j < L.length && L[j].y - L[i].y < 3.8 * s; j++) {
      for (const div of [1, 2, 3]) {          // L[j] = ligne suivante, ou une plus loin (lignes manquantes)
        const m = (L[j].y - L[i].y) / div;
        if (m < 0.6 * s || m > 1.5 * s) continue;
        const idx = [i], ys = [L[i].y];
        for (let k = 1; k <= 4; k++) {
          const cible = L[i].y + k * m;
          let bj = -1, bd = Infinity;
          for (let q = i + 1; q < L.length && L[q].y < cible + m; q++) { const d = Math.abs(L[q].y - cible); if (d < bd) { bd = d; bj = q; } }
          if (bj >= 0 && bd < 0.22 * m + 1 && !pris.has(bj)) { idx.push(bj); ys.push(L[bj].y); } else { idx.push(-1); ys.push(cible); }
        }
        const trouvees = idx.filter(q => q >= 0).length;
        if (trouvees >= 4 && (!meilleur || trouvees > meilleur.trouvees)) meilleur = { idx, ys, trouvees, m };
      }
    }
    if (meilleur) {
      // espacement affiné par moindres carrés sur les lignes trouvées
      const pts = meilleur.idx.map((q, k) => q >= 0 ? [k, L[q].y] : null).filter(Boolean);
      const mk = pts.reduce((a, c) => a + c[0], 0) / pts.length, my = pts.reduce((a, c) => a + c[1], 0) / pts.length;
      const pente = pts.reduce((a, c) => a + (c[0] - mk) * (c[1] - my), 0) / pts.reduce((a, c) => a + (c[0] - mk) ** 2, 0);
      let ys = [0, 1, 2, 3, 4].map(k => meilleur.idx[k] >= 0 ? L[meilleur.idx[k]].y : my + (k - mk) * pente);
      if (meilleur.idx[4] < 0) {
        // ligne du bas manquante… ou bien c'est celle du haut ? on garde la plus sombre
        const sc = yy => { const r = Math.round(yy); let m2 = 0; for (let d = -1; d <= 1; d++) if (r + d >= 0 && r + d < h) m2 = Math.max(m2, score[r + d]); return m2; };
        const yHaut = ys[0] - pente;
        if (yHaut > 0 && sc(yHaut) > sc(ys[4])) ys = [yHaut, ys[0], ys[1], ys[2], ys[3]];
      }
      meilleur.idx.forEach(q => q >= 0 && pris.add(q));
      const eps = meilleur.idx.filter(q => q >= 0).map(q => L[q].ep);
      portees.push({ lignes: ys, haut: ys[0], bas: ys[4], s: pente, ep: Math.max(...eps) });
    }
  }
  // étendue horizontale : colonnes où ≥4 des 5 lignes sont noires
  portees.forEach(P => {
    // plus longue étendue continue où ≥4 des 5 lignes sont noires (trous < 1,5 interligne tolérés),
    // pour ignorer un trait vertical isolé (bord de page, cadre de l'appli…)
    const noirA = (x, y) => { const yy = Math.round(y); return b[yy * w + x] || b[Math.max(0, yy - 1) * w + x] || b[Math.min(h - 1, yy + 1) * w + x]; };
    let meilleur = [-1, -1], deb = -1, der = -1;
    for (let x = 0; x <= w; x++) {
      let n = 0; if (x < w) for (const y of P.lignes) n += noirA(x, y) ? 1 : 0;
      if (n >= 4) { if (deb < 0 || x - der > 5 * P.s) { deb = x; } der = x; }
      if (deb >= 0 && der - deb > meilleur[1] - meilleur[0]) meilleur = [deb, der];
    }
    P.gauche = meilleur[0]; P.droite = meilleur[1];
  });
  return portees.filter(P => P.droite - P.gauche > 10 * P.s);
}

// Suppression des lignes de portée (et lignes supplémentaires) : on efface les
// pixels noirs dont la plage verticale est à peine plus épaisse qu'une ligne.
function supprimerLignes(b, w, h, portees) {
  const plage = new Uint16Array(w * h);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!b[y * w + x]) { y++; continue; }
      let y2 = y; while (y2 < h && b[y2 * w + x]) y2++;
      for (let k = y; k < y2; k++) plage[k * w + x] = y2 - y;
      y = y2;
    }
  }
  const B2 = b.slice();
  portees.forEach(P => {
    const lim = P.ep + 1, x0 = Math.max(0, P.gauche - Math.round(P.s)), x1 = Math.min(w, P.droite + Math.round(P.s));
    const lignes = [...P.lignes];
    for (let k = 1; k <= 6; k++) { lignes.push(P.haut - k * P.s); lignes.push(P.bas + k * P.s); }
    lignes.forEach((ly, idx) => {
      const marge = idx < 5 ? Math.ceil(P.ep / 2) + 1 : Math.ceil(P.ep / 2) + Math.round(P.s * 0.15) + 1;
      const ya = Math.max(0, Math.round(ly) - marge), yb = Math.min(h - 1, Math.round(ly) + marge);
      for (let y = ya; y <= yb; y++) for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (b[i] && plage[i] <= lim) B2[i] = 0;
      }
    });
  });
  return B2;
}

// ---------------------------------------------------------------------
//  Composantes connexes (8-connexité)
// ---------------------------------------------------------------------
function composantes(B, w, h) {
  const lab = new Int32Array(w * h), comps = [];
  const pile = new Int32Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!B[i] || lab[i]) continue;
    n++; let sp = 0; pile[sp++] = i; lab[i] = n;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, cnt = 0;
    while (sp) {
      const j = pile[--sp], x = j % w, y = (j / w) | 0;
      cnt++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (B[k] && !lab[k]) { lab[k] = n; pile[sp++] = k; }
      }
    }
    comps.push({ id: n, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, n: cnt });
  }
  return { lab, comps };
}

// nombre de segments noirs sur une ligne (ou colonne) d'une composante
function segmentsLigne(lab, w, id, y, x0, x1) {
  let n = 0, prev = false;
  for (let x = x0; x <= x1; x++) { const v = lab[y * w + x] === id; if (v && !prev) n++; prev = v; }
  return n;
}
function largeurLigne(lab, w, id, y, x0, x1) {
  let a = -1, z = -1; for (let x = x0; x <= x1; x++) if (lab[y * w + x] === id) { if (a < 0) a = x; z = x; }
  return a < 0 ? 0 : z - a + 1;
}

// Classe une altération (#, b, bécarre) d'après sa forme
function formeAlteration(b, w, g, P) {
  const lignes = [...P.lignes]; for (let k = 1; k <= 6; k++) { lignes.push(P.haut - k * P.s); lignes.push(P.bas + k * P.s); }
  const eviter = y => {
    for (const ly of lignes) if (Math.abs(y - ly) <= P.ep / 2 + 1) return y < (g.y0 + g.y1) / 2 ? Math.round(ly + P.ep / 2 + 2) : Math.round(ly - P.ep / 2 - 2);
    return y;
  };
  const row = f => eviter(Math.round(g.y0 + f * (g.h - 1)));
  const seg = f => { const y = row(f); let n = 0, prev = 0; for (let x = g.x0; x <= g.x1; x++) { const v = b[y * w + x]; if (v && !prev) n++; prev = v; } return n; };
  const larg = f => { const y = row(f); let a = -1, z = -1; for (let x = g.x0; x <= g.x1; x++) if (b[y * w + x]) { if (a < 0) a = x; z = x; } return a < 0 ? 0 : z - a + 1; };
  const frac2 = (a, z) => { let n = 0, tot = 0; for (let f = a; f <= z + 1e-9; f += 0.05) { tot++; if (seg(f) >= 2) n++; } return n / tot; };
  if (frac2(0.08, 0.32) >= 0.4 && frac2(0.68, 0.92) >= 0.4) return 'diese';
  // trait vertical continu à gauche (hampe du bémol, trait gauche du bécarre) : absent d'un soupir
  let couv = 0, tot = 0;
  for (let y = g.y0; y <= g.y1; y++) { tot++; for (let x = g.x0; x <= g.x0 + Math.max(1, Math.round(0.25 * P.s)); x++) if (b[y * w + x]) { couv++; break; } }
  if (couv / tot < 0.75) return 'autre';
  if (larg(0.75) > 1.9 * larg(0.2) && larg(0.2) < 0.5 * g.w) return 'bemol';
  return 'becarre';
}

// regroupe les morceaux d'un même symbole (coupés par la suppression des lignes)
function grouper(liste, s) {
  const L = liste.slice().sort((a, c) => a.x0 - c.x0), parent = L.map((_, i) => i);
  const f = i => parent[i] === i ? i : (parent[i] = f(parent[i]));
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length && L[j].x0 <= L[i].x1 + 0.35 * s; j++) {
    const a = L[i], c = L[j];
    const recouvre = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0) + 1;
    const ecart = Math.max(a.y0, c.y0) - Math.min(a.y1, c.y1);
    const petit = Math.min(a.h, c.h) < 1.5 * s || Math.min(a.w, c.w) < 0.3 * s;
    if (petit && recouvre >= 0.3 * Math.min(a.w, c.w) && ecart <= 0.6 * s) { parent[f(j)] = f(i); continue; }
    // trait vertical fin juste à gauche d'un autre morceau (hampe de bémol, traits de dièse/bécarre)
    const fin = a.w < 0.3 * s && a.h > 1.5 * s && a.x1 < c.x0;
    if (fin && c.x0 - a.x1 <= 0.35 * s && -ecart > 0.3 * s && c.w < 1.1 * s) parent[f(j)] = f(i);
  }
  const G = new Map();
  L.forEach((c, i) => {
    const r = f(i); const g = G.get(r) || { x0: Infinity, x1: -1, y0: Infinity, y1: -1, n: 0, ids: [] };
    g.x0 = Math.min(g.x0, c.x0); g.x1 = Math.max(g.x1, c.x1); g.y0 = Math.min(g.y0, c.y0); g.y1 = Math.max(g.y1, c.y1); g.n += c.n; g.ids.push(c.id);
    G.set(r, g);
  });
  return [...G.values()].map(g => Object.assign(g, { w: g.x1 - g.x0 + 1, h: g.y1 - g.y0 + 1 })).sort((a, c) => a.x0 - c.x0);
}

// ---------------------------------------------------------------------
//  Analyse principale
// ---------------------------------------------------------------------
function analyser(G, opts = {}) {
  const debug = { etapes: [] };
  let { w, h } = G;
  // marges sombres (page affichée sur fond noir, bandes de l'appli) : on les blanchit
  {
    const g = G.g.slice(), sombreCol = x => { let n = 0; for (let y = 0; y < h; y += 2) if (g[y * w + x] < 90) n++; return n > 0.85 * (h / 2); };
    const sombreRang = y => { let n = 0; for (let x = 0; x < w; x += 2) if (g[y * w + x] < 90) n++; return n > 0.85 * (w / 2); };
    let x0 = 0; while (x0 < w / 3 && sombreCol(x0)) x0++;
    let x1 = w - 1; while (x1 > 2 * w / 3 && sombreCol(x1)) x1--;
    let y0 = 0; while (y0 < h / 3 && sombreRang(y0)) y0++;
    let y1 = h - 1; while (y1 > 2 * h / 3 && sombreRang(y1)) y1--;
    if (x0 > 0 || x1 < w - 1 || y0 > 0 || y1 < h - 1) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < x0 || x > x1 || y < y0 || y > y1) g[y * w + x] = 255;
      G = { w, h, g };
      debug.marges = { x0, x1, y0, y1 };
    }
  }
  // 0. mise à l'échelle : interligne visé ≈ 16 px (agrandit les petites captures, réduit les grosses photos)
  {
    const G0 = G, b0 = binariser(G, 25), e0 = estimerInterligne(b0, w, h);
    let k = 16 / e0.s;                              // toujours la même échelle de travail
    k = Math.min(k, Math.sqrt(9e6 / (w * h)));   // garde l'image sous ~9 Mpx
    if (Math.abs(k - 1) > 0.03) { G = redimensionner(G, k); w = G.w; h = G.h; }
    debug.echelle = k; debug.interligneOrigine = e0.s;
    // traits fins (hampes, lignes gris clair) : petite image, ou capture d'écran nette (fond blanc pur, pas une photo)
    let blancPur = 0; for (let i = 0; i < G0.g.length; i += 7) if (G0.g[i] >= 250) blancPur++;
    debug.propre = blancPur / (G0.g.length / 7) > 0.6;
    debug.fin = e0.s < 15 || debug.propre;
  }
  // 1. binarisation provisoire, interligne, redressement
  let b = binariser(G, 25);
  let est = estimerInterligne(b, w, h);
  const angle = opts.redresser === false ? 0 : estimerAngle(b, w, h);
  if (Math.abs(angle) >= 0.2) { G = tourner(G, angle); }
  const fen = Math.max(21, Math.round(est.s * 3) | 1);
  // petites images agrandies : traits fins (hampes, lignes) devenus gris clair → seuil plus sensible
  b = binariser(G, fen, debug.fin ? 0.95 : 0.9);
  est = estimerInterligne(b, w, h);
  debug.angle = angle; debug.interligne = est.s;
  // 2. portées (binarisation plus sensible : les lignes fines deviennent gris clair sur les petites images)
  const bLignes = debug.fin ? binariser(G, fen, 0.95) : b;
  const portees = trouverPortees(bLignes, w, h, est.s, est.t);
  if (!portees.length) return { erreur: 'Aucune portée trouvée. Essaie une image plus nette, bien droite, et cadrée sur la partition.', debug, G };
  // 3. suppression des lignes
  const B2 = supprimerLignes(b, w, h, portees);
  const I2 = integrale(w, h, B2);
  const remp = (x0, y0, x1, y1) => {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0)); x1 = Math.min(w, Math.round(x1)); y1 = Math.min(h, Math.round(y1));
    if (x1 <= x0 || y1 <= y0) return 0;
    return somme(I2, w, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
  };
  const noir = (x, y) => x >= 0 && y >= 0 && x < w && y < h && B2[(y | 0) * w + (x | 0)] === 1;
  const { lab, comps } = composantes(B2, w, h);
  const compDe = (x, y) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return null; const id = lab[y * w + x]; return id ? comps[id - 1] : null; };

  debug.sonde = (x, y, s) => ({ coeur: remp(x - 0.5 * s, y - 0.28 * s, x + 0.5 * s, y + 0.28 * s), noir: noir(x, y), b: b[Math.round(y) * w + Math.round(x)] });
  // 4. systèmes : portées par paires si partition de piano
  let piano = opts.piano;
  if (piano === undefined || piano === 'auto') {
    piano = false;
    if (portees.length >= 2 && portees.length % 2 === 0) {
      // reliées par une barre/accolade commune ? on teste les barres de mesure qui traversent l'espace entre portées
      let liees = 0;
      for (let k = 0; k + 1 < portees.length; k += 2) {
        const A = portees[k], Bp = portees[k + 1];
        const ym = Math.round((A.bas + Bp.haut) / 2);
        for (let x = Math.max(A.gauche, Bp.gauche); x <= Math.min(A.droite, Bp.droite); x++) {
          if (noir(x, ym) && noir(x, A.bas + 1) && noir(x, Bp.haut - 1)) {
            let ok = true; for (let y = Math.round(A.bas); y <= Math.round(Bp.haut); y++) if (!noir(x, y) && !noir(x + 1, y) && !noir(x - 1, y)) { ok = false; break; }
            if (ok) { liees++; break; }
          }
        }
      }
      piano = liees >= portees.length / 4;
    }
  }
  portees.forEach((P, i) => { P.index = i; P.role = piano ? (i % 2 === 0 ? 'haut' : 'bas') : 'seule'; P.systeme = piano ? i >> 1 : i; });

  // 5. têtes de notes
  const tetes = [];
  portees.forEach(P => {
    const s = P.s, demi = s / 2;
    for (let p = -7; p <= 15; p++) {
      const y = P.bas - p * demi;
      const cand = [];
      for (let x = Math.max(P.gauche, 0); x <= Math.min(P.droite + s, w - 1); x++) {
        const coeur = remp(x - 0.5 * s, y - 0.28 * s, x + 0.5 * s, y + 0.28 * s);
        if (coeur >= 0.8) {
          const gch = remp(x - 1.55 * s, y - 0.22 * s, x - 0.95 * s, y + 0.22 * s), drt = remp(x + 0.95 * s, y - 0.22 * s, x + 1.55 * s, y + 0.22 * s);
          const haut = remp(x - 0.2 * s, y - 1.15 * s, x + 0.2 * s, y - 0.75 * s), bas = remp(x - 0.2 * s, y + 0.75 * s, x + 0.2 * s, y + 1.15 * s);
          if (gch > 0.5 && drt > 0.5) continue;           // ligature horizontale
          // épaisseur verticale au centre : ~1 interligne pour une tête, ~0,5 pour une ligature
          let ya = Math.round(y), yb = Math.round(y);
          while (ya > 0 && noir(x, ya - 1)) ya--; while (yb < h - 1 && noir(x, yb + 1)) yb++;
          if (yb - ya + 1 < 0.72 * s) continue;
          if (haut > 0.7 && bas > 0.7) continue;          // masse verticale (clé, chiffre…)
          cand.push({ x, y, p, plein: true, score: coeur, P });
        } else {
          const inter = remp(x - 0.26 * s, y - 0.09 * s, x + 0.26 * s, y + 0.09 * s);
          if (inter > 0.12) continue;
          const g1 = remp(x - 0.66 * s, y - 0.12 * s, x - 0.36 * s, y + 0.12 * s), d1 = remp(x + 0.36 * s, y - 0.12 * s, x + 0.66 * s, y + 0.12 * s);
          if (g1 < 0.45 || d1 < 0.45) continue;
          const dessus = remp(x - 0.3 * s, y - 0.5 * s, x + 0.3 * s, y - 0.3 * s), dessous = remp(x - 0.3 * s, y + 0.3 * s, x + 0.3 * s, y + 0.5 * s);
          if (dessus < 0.3 || dessous < 0.3) continue;
          const gx = remp(x - 1.4 * s, y - 0.1 * s, x - 0.85 * s, y + 0.1 * s), dx = remp(x + 0.85 * s, y - 0.1 * s, x + 1.4 * s, y + 0.1 * s);
          if (gx > 0.6 && dx > 0.6) continue;
          cand.push({ x, y, p, plein: false, score: 0.5 + (g1 + d1) / 4 - inter + (dessus + dessous) / 4, P });
        }
      }
      // maxima locaux en x
      cand.sort((a, c) => c.score - a.score);
      const pris = [];
      cand.forEach(c => { if (!pris.some(o => Math.abs(o.x - c.x) < 0.9 * s)) pris.push(c); });
      tetes.push(...pris);
    }
  });
  debug.brutes = tetes.slice();
  // têtes vides par les "trous" : petites zones blanches entièrement entourées de noir
  {
    const lab4 = new Int32Array(w * h), pile = new Int32Array(w * h); let nl = 0;
    const smax = Math.max(...portees.map(P => P.s));
    for (let i0 = 0; i0 < w * h; i0++) {
      if (B2[i0] || lab4[i0]) continue;
      nl++; let sp = 0; pile[sp++] = i0; lab4[i0] = nl;
      let n = 0, sx = 0, sy = 0, bord = false, x0 = w, x1 = 0, y0 = h, y1 = 0;
      while (sp) {
        const j = pile[--sp], x = j % w, y = (j / w) | 0;
        n++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) bord = true;
        if (n > smax * smax) { bord = true; }
        const voisins = [j - 1, j + 1, j - w, j + w];
        for (let q = 0; q < 4; q++) {
          const k = voisins[q];
          if (k < 0 || k >= w * h || (q < 2 && ((k / w) | 0) !== y)) continue;
          if (!B2[k] && !lab4[k]) { lab4[k] = nl; pile[sp++] = k; }
        }
      }
      if (bord || n < 3) continue;
      const cx = sx / n, cy = sy / n;
      // portée la plus proche
      let P = null, dmin = Infinity;
      portees.forEach(Q => { const d = cy < Q.haut ? Q.haut - cy : cy > Q.bas ? cy - Q.bas : 0; if (d < dmin && cx > Q.gauche && cx < Q.droite + Q.s) { dmin = d; P = Q; } });
      if (!P || dmin > 4 * P.s) continue;
      const sP = P.s;
      if (x1 - x0 + 1 > 1.0 * sP || y1 - y0 + 1 > 0.75 * sP || n > 0.45 * sP * sP || n < 0.05 * sP * sP) continue;
      const pp = Math.round((P.bas - cy) / (sP / 2)), yp = P.bas - pp * sP / 2;
      if (Math.abs(cy - yp) > 0.35 * sP) continue;
      // anneau : largeur extérieure sur la rangée du centre
      const r = Math.round(cy);
      let g = Math.round(cx); while (g > 0 && !B2[r * w + g]) g--; let ge = g; while (ge > 0 && B2[r * w + ge]) ge--;
      let d = Math.round(cx); while (d < w - 1 && !B2[r * w + d]) d++; let de = d; while (de < w - 1 && B2[r * w + de]) de++;
      const ext = de - ge - 1;
      if (ext < 0.95 * sP || ext > 2.2 * sP) continue;
      if (g - ge < 1 || de - d < 1) continue;
      // pas une ligature / masse : au-dessus et en dessous du trou, l'anneau est fin
      tetes.push({ x: Math.round(cx), y: yp, p: pp, plein: false, score: 1.3, P, parTrou: true });
    }
  }
  // suppression entre positions voisines
  tetes.sort((a, c) => c.score - a.score);
  let T = [];
  tetes.forEach(t => { if (!T.some(o => o.P === t.P && Math.abs(o.x - t.x) < 0.8 * t.P.s && Math.abs(o.p - t.p) <= 1)) T.push(t); });

  // 6. hampes (sur une image agrandie, les hampes fines deviennent gris très clair : binarisation dédiée)
  const bH = debug.fin ? binariser(G, fen, 0.985) : null;
  const noirH = (x, y) => bH ? (x >= 0 && y >= 0 && x < w && y < h && (bH[(y | 0) * w + (x | 0)] === 1 || B2[(y | 0) * w + (x | 0)] === 1)) : noir(x, y);
  const trouMax = bH ? 2 : 1;
  const longueurHampe = (xa, xb, y0, dir) => {
    let best = 0, col = -1;
    for (let x = Math.round(xa); x <= Math.round(xb); x++) {
      let y = Math.round(y0), n = 0, trou = 0;
      const sL = est.s;
      while (y >= 0 && y < h) {
        if (noirH(x, y)) { n += 1 + trou; trou = 0; }
        else if (trou < trouMax) trou++;
        else {
          // coupure plus longue : la hampe reprend-elle un peu plus loin dans la même colonne ?
          let saut = 0;
          if (bH) for (let k = 1; k <= 0.6 * sL; k++) {
            const yy = y + dir * k; let run = 0;
            while (run < sL && noirH(x, yy + dir * run)) run++;
            if (run >= 0.9 * sL) { saut = k; break; }
          }
          if (!saut) break;
          n += trou + saut; trou = 0; y += dir * saut; continue;
        }
        y += dir;
      }
      if (n > best) { best = n; col = x; }
    }
    return { len: best, col };
  };
  T.forEach(t => {
    const s = t.P.s;
    const up = longueurHampe(t.x + 0.25 * s, t.x + 0.85 * s, t.y, -1);
    const dn = longueurHampe(t.x - 0.85 * s, t.x - 0.25 * s, t.y, +1);
    const lmin = 2.3 * s;
    if (up.len >= lmin && up.len >= dn.len) { t.hampe = { dir: -1, col: up.col, bout: t.y - up.len, len: up.len }; }
    else if (dn.len >= lmin) { t.hampe = { dir: 1, col: dn.col, bout: t.y + dn.len, len: dn.len }; }
  });
  debug.avantHampe = T.slice();
  // une note loin au-dessus / au-dessous de la portée doit avoir une ligne supplémentaire entre elle et la portée
  // (élimine p. ex. la petite note de l'indication de tempo « ♩ = 89 »)
  const ligneSupp = (x, y, s) => {
    for (let dy = -2; dy <= 2; dy++) {
      const yy = Math.round(y + dy); if (yy < 0 || yy >= h) continue;
      let run = 0, best = 0;
      for (let xx = Math.round(x - 1.1 * s); xx <= Math.round(x + 1.1 * s); xx++) { if (xx >= 0 && xx < w && b[yy * w + xx]) { run++; best = Math.max(best, run); } else run = 0; }
      if (best >= 1.1 * s) return true;
    }
    return false;
  };
  T = T.filter(t => {
    const s = t.P.s;
    if (t.p >= 10) return ligneSupp(t.x, t.P.haut - s, s);
    if (t.p <= -2) return ligneSupp(t.x, t.P.bas + s, s);
    return true;
  });
  // une "tête pleine" sans hampe est suspecte (souvent un bout de symbole)
  T = T.filter(t => !t.plein || t.hampe);

  // 7. crochets / ligatures
  // suit un trait épais horizontalement depuis la hampe ; renvoie la longueur parcourue
  const suivre = (x0, y0, dir, s) => {
    let y = y0, n = 0;
    for (let x = x0 + dir; Math.abs(x - x0) < 3.5 * s; x += dir) {
      let best = null;
      for (let dy = -Math.round(0.45 * s); dy <= Math.round(0.45 * s); dy++) if (noir(x, y + dy) && (best === null || Math.abs(dy) < Math.abs(best))) best = dy;
      if (best === null) break;
      y += best; n++;
    }
    return n;
  };
  const compterTraits = (x, ya, yb, s, fusion) => {
    let n = 0, run = 0;
    const fin = () => { if (run >= 0.18 * s) n += run > fusion * s ? 2 : 1; run = 0; };
    for (let y = Math.round(ya); y <= Math.round(yb); y++) { if (noir(x, y)) run++; else fin(); }
    fin(); return n;
  };
  T.forEach(t => {
    if (!t.plein || !t.hampe) { t.traits = 0; return; }
    const s = t.P.s, H = t.hampe;
    const zone = Math.min(2.2 * s, H.len - 1.1 * s);
    const ya = H.dir < 0 ? H.bout : H.bout - zone, yb = H.dir < 0 ? H.bout + zone : H.bout;
    const yBout = H.dir < 0 ? H.bout + 0.2 * s : H.bout - 0.2 * s;
    const lg = suivre(H.col - Math.round(0.15 * s), Math.round(yBout), -1, s), ld = suivre(H.col + Math.round(0.15 * s), Math.round(yBout), 1, s);
    t.ligature = lg >= 1.3 * s || ld >= 1.6 * s;
    let maxN = 0;
    if (t.ligature) {
      const cols = [];
      if (lg >= 1.3 * s) cols.push(-0.55, -0.9);
      if (ld >= 1.6 * s) cols.push(0.55, 0.9);
      cols.forEach(dxs => { maxN = Math.max(maxN, compterTraits(Math.round(H.col + dxs * s), ya, yb, s, 0.95)); });
    } else {
      // crochets : toujours à droite de la hampe, séparés par de petits blancs
      [0.4, 0.6].forEach(dxs => { maxN = Math.max(maxN, compterTraits(Math.round(H.col + dxs * s), ya, yb, s, 1.8)); });
    }
    t.traits = Math.min(3, maxN);
  });

  // 8. points de prolongation
  T.forEach(t => {
    const s = t.P.s, yd = (((t.p % 2) + 2) % 2 === 0) ? t.y - 0.5 * s : t.y;
    t.point = false;
    for (let x = t.x + 0.75 * s; x <= t.x + 2.0 * s; x += 1) {
      const c = remp(x - 0.16 * s, yd - 0.16 * s, x + 0.16 * s, yd + 0.16 * s);
      if (c < 0.7) continue;
      const tour = remp(x - 0.5 * s, yd - 0.5 * s, x + 0.5 * s, yd + 0.5 * s);
      const aire = 1, petit = (0.32 * 0.32);
      const anneau = (tour * aire - c * petit) / (aire - petit);
      if (anneau < 0.22) { const comp = compDe(x, yd); if (comp && comp.w < 0.8 * s && comp.h < 1.0 * s) { t.point = true; break; } }
    }
  });

  // composantes contenant une tête
  const avecTete = new Set();
  T.forEach(t => { const c = compDe(t.x + (t.plein ? 0 : 0.5 * t.P.s), t.y); if (c) avecTete.add(c.id); });

  // 9. clé, armure, en-tête de chaque portée
  const porteeDe = (c) => {
    const yc = (c.y0 + c.y1) / 2; let best = null, d = Infinity;
    portees.forEach(P => { const dd = yc < P.haut ? P.haut - yc : yc > P.bas ? yc - P.bas : 0; if (dd < d && c.x1 >= P.gauche - P.s && c.x0 <= P.droite + P.s) { d = dd; best = P; } });
    return d <= 3 * (best ? best.s : 0) ? best : null;
  };
  const parPortee = new Map(portees.map(P => [P, []]));
  comps.forEach(c => { if (c.n < 4) return; const P = porteeDe(c); if (P) parPortee.get(P).push(c); });
  portees.forEach(P => {
    const s = P.s, liste = parPortee.get(P).slice().sort((a, c) => a.x0 - c.x0);
    P.cle = null; P.armure = 0; P.debutMusique = P.gauche;
    const debutCle = liste.filter(c => c.x0 >= P.gauche - 0.3 * s && c.x0 < P.gauche + 3.2 * s && c.w > 0.3 * s && c.h > 0.3 * s && c.y1 > P.haut - 2.5 * s && c.y0 < P.bas + 2.5 * s);
    let cle = null;
    if (debutCle.length) {
      cle = { x0: Math.min(...debutCle.map(c => c.x0)), x1: Math.max(...debutCle.map(c => c.x1)), y0: Math.min(...debutCle.map(c => c.y0)), y1: Math.max(...debutCle.map(c => c.y1)) };
      if (cle.y1 - cle.y0 < 2.4 * s) cle = null;
    }
    if (cle) {
      P.cle = (cle.y0 < P.haut - 0.7 * s && cle.y1 > P.bas + 0.7 * s) ? 'sol' : 'fa'; P.cleComp = cle;
      let fin = cle.x1, n = 0, type = null;
      P.dbgArmure = [];
      const groupes = grouper(liste.filter(c => c.x0 > cle.x1 - 0.2 * s), s);
      for (const c of groupes) {
        P.dbgArmure.push(c);
        if (c.w < 0.65 * s && c.h < 1.6 * s) { fin = Math.max(fin, c.x1); continue; } // points de la clé de fa, poussières
        if (c.x0 - fin > 1.8 * s) break;
        if (c.h < 1.6 * s || c.h > 3.6 * s || c.w > 1.25 * s || c.w < 0.4 * s) break;
        const f = formeAlteration(b, w, c, P);
        c.forme = f;
        if (!type) {
          if (f === 'autre') break;
          // le 1er dièse est toujours sur Fa, le 1er bémol sur Si : la hauteur suffit, même sur une image floue
          const pc = (P.bas - (c.y0 + c.y1) / 2) / (s / 2);
          const seuilPos = P.cle === 'fa' ? 4.6 : 6.6;
          type = pc > seuilPos ? 'diese' : 'bemol';
          if (f === 'becarre' && P.s > 0 && debug.echelle <= 1.3) { type = null; break; }
        }
        n++; fin = c.x1;
      }
      P.armure = type === 'diese' ? n : type === 'bemol' ? -n : 0;
      P.debutMusique = fin + 0.3 * s;
      // chiffrage (deux chiffres empilés) juste après
      const chiffres = groupes.filter(c => c.x0 > fin && c.x0 - fin < 2.5 * s && c.w > 0.9 * s && c.w < 2.2 * s && c.h > 1.3 * s && c.h < 2.4 * s);
      // sur une petite image, les deux chiffres se touchent : un seul bloc haut comme la portée
      const bloc = groupes.find(c => c.x0 > fin && c.x0 - fin < 2.5 * s && c.w > 0.8 * s && c.w < 2.2 * s && c.h > 3.2 * s && c.h < 4.9 * s &&
        c.y0 > P.haut - 0.6 * s && c.y1 < P.bas + 0.6 * s);
      if (chiffres.length >= 2) P.debutMusique = Math.max(...chiffres.map(c => c.x1)) + 0.3 * s;
      else if (bloc) P.debutMusique = bloc.x1 + 0.3 * s;
    }
  });
  T = T.filter(t => t.x > t.P.debutMusique);

  // 10. barres de mesure
  const barres = new Map(portees.map(P => [P, []]));
  comps.forEach(c => {
    if (avecTete.has(c.id)) return;
    portees.forEach(P => {
      const s = P.s;
      if (c.w > 0.65 * s || c.x0 < P.debutMusique - 0.5 * s) return;
      if (c.y0 <= P.haut + 0.4 * s && c.y1 >= P.bas - 0.4 * s && c.h >= 3.6 * s) {
        // la barre doit s'arrêter aux lignes extrêmes (pas une hampe isolée)
        const finHaut = c.y0 >= P.haut - 0.6 * s || (piano && P.role === 'bas'), finBas = c.y1 <= P.bas + 0.6 * s || (piano && P.role === 'haut');
        if (finHaut && finBas) barres.get(P).push((c.x0 + c.x1) / 2);
      }
    });
  });
  barres.forEach((xs, P) => { xs.sort((a, c) => a - c); const m = []; xs.forEach(x => { if (!m.length || x - m[m.length - 1] > 1.2 * P.s) m.push(x); else m[m.length - 1] = x; }); barres.set(P, m); });

  // 11. altérations accidentelles
  const utilisees = new Set();
  T.forEach(t => {
    const s = t.P.s; t.alteration = null;
    const proches = parPortee.get(t.P).filter(c => !avecTete.has(c.id) && c.x1 < t.x - 0.45 * s && c.x1 > t.x - 2.6 * s && c.y1 > t.y - 2.5 * s && c.y0 < t.y + 2.5 * s);
    const cands = grouper(proches, s).filter(g => g.x1 > t.x - 2.4 * s && g.h > 1.8 * s && g.h < 3.6 * s && g.w > 0.35 * s && g.w < 1.3 * s && g.y0 < t.y && g.y1 > t.y &&
      Math.abs((g.y0 + g.y1) / 2 - t.y) < 1.1 * s);   // une altération est centrée sur sa note (le bémol un peu plus haut)
    if (!cands.length) return;
    const g = cands.sort((a, d) => d.x1 - a.x1)[0];
    let f = formeAlteration(b, w, g, t.P);
    if (f === 'autre') return;
    if (f !== 'diese' && (t.y - g.y0) > 1.2 * s && (g.y1 - t.y) < 0.9 * s) f = 'bemol';
    else if (f === 'bemol' && Math.abs((g.y0 + g.y1) / 2 - t.y) < 0.4 * s) f = 'becarre';
    t.alteration = f; g.ids.forEach(id => utilisees.add(id));
  });

  // 12. silences
  const silences = [];
  portees.forEach(P => {
    const s = P.s;
    parPortee.get(P).forEach(c => {
      if (avecTete.has(c.id) || utilisees.has(c.id) || c.x0 < P.debutMusique) return;
      if (c.y0 < P.haut - 0.8 * s || c.y1 > P.bas + 0.8 * s) return;
      const rx = c.w / s, ry = c.h / s, yc = (c.y0 + c.y1) / 2, fill = c.n / (c.w * c.h);
      let dur = null;
      if (rx > 0.8 && rx < 1.8 && ry > 0.3 && ry < 0.8 && fill > 0.7) dur = yc < P.haut + 1.5 * s ? 4 : 2;
      else if (ry >= 2.15 && ry < 3.6 && rx > 0.5 && rx < 1.4) {
        // soupir (une seule masse par ligne) vs altération (deux traits)
        const rows = [0.3, 0.5, 0.7].map(f => segmentsLigne(lab, w, c.id, Math.round(c.y0 + f * c.h), c.x0, c.x1));
        if (rows.every(n => n <= 1)) dur = 1;
        else if (rx > 0.7 && formeAlteration(b, w, c, P) === 'autre') {
          // quart de soupir : trait oblique + deux crochets à gauche (pas de trait vertical droit comme un dièse)
          const deux = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65].filter(f => segmentsLigne(lab, w, c.id, Math.round(c.y0 + f * c.h), c.x0, c.x1) >= 2).length;
          if (deux >= 1) dur = 0.25;
        }
      } else if (ry >= 1.2 && ry < 2.15 && rx > 0.45 && rx < 1.3 && fill < 0.6) dur = 0.5;
      if (dur) {
        if (T.some(t => t.P === P && Math.abs(t.x - (c.x0 + c.x1) / 2) < 0.8 * s)) return;
        silences.push({ x: (c.x0 + c.x1) / 2, y: yc, dur, P, comp: c });
      }
    });
  });

  // 13. assemblage : par système / portée, de gauche à droite
  const lirePortee = (P, voixHaute) => {
    const s = P.s;
    const notes = T.filter(t => t.P === P).sort((a, c) => a.x - c.x);
    // accords : même colonne → une seule note (voix extérieure)
    const groupes = [];
    notes.forEach(t => {
      const g = groupes.find(G => Math.abs(G.x - t.x) < 0.7 * s || (t.hampe && G.hampe && Math.abs(G.hampe.col - t.hampe.col) < 0.3 * s && Math.abs(G.x - t.x) < 1.6 * s));
      if (g) { g.notes.push(t); g.accord = true; } else groupes.push({ x: t.x, hampe: t.hampe, notes: [t] });
    });
    const ev = [];
    groupes.forEach(g => {
      const n = g.notes.reduce((a, c) => (voixHaute ? c.p > a.p : c.p < a.p) ? c : a);
      const ref = g.notes.find(x => x.hampe) || n;
      let dur = n.plein ? 1 / Math.pow(2, ref.traits || 0) : (ref.hampe ? 2 : 4);
      if (g.notes.some(x => x.point)) dur *= 1.5;
      ev.push({ type: 'note', x: n.x, y: n.y, p: n.p, dur, tete: n, accord: !!g.accord, alteration: n.alteration, P });
    });
    silences.filter(r => r.P === P).forEach(r => ev.push({ type: 'silence', x: r.x, y: r.y, dur: r.dur, P }));
    barres.get(P).forEach(x => ev.push({ type: 'barre', x, P }));
    ev.sort((a, c) => a.x - c.x);
    return ev;
  };

  // portées retenues
  let choix;
  if (piano) choix = portees.filter(P => P.role === (opts.main === 'gauche' ? 'bas' : 'haut'));
  else choix = portees;
  const armures = portees.map(P => P.armure).filter(a => a !== null);
  let armure = opts.armure !== undefined && opts.armure !== 'auto' ? +opts.armure : (choix[0] ? choix[0].armure : 0);
  if (opts.armure === undefined || opts.armure === 'auto') {
    // vote majoritaire sur les portées retenues
    // une armure vue sur au moins 1/3 des portées l'emporte sur "pas d'armure" (souvent un raté)
    const cpt = {}; portees.forEach(P => cpt[P.armure] = (cpt[P.armure] || 0) + 1);
    // on rate souvent une altération de l'armure, on en ajoute rarement une : type majoritaire (♯ ou ♭),
    // puis le plus grand nombre vu pour ce type
    const vals = portees.map(P => P.armure).filter(a => a);
    const nD = vals.filter(a => a > 0).length, nB = vals.filter(a => a < 0).length;
    if (!vals.length || Math.max(nD, nB) < Math.max(1, portees.length / 4)) armure = 0;
    else {
      const memeType = vals.filter(a => (nD >= nB ? a > 0 : a < 0)).map(Math.abs).sort((a, c) => c - a);
      const vu2 = memeType.find((v, i) => memeType.indexOf(v) !== i);       // plus grand nombre vu au moins 2 fois
      const n = vu2 !== undefined ? vu2 : memeType[memeType.length >> 1];
      armure = nD >= nB ? n : -n;
    }
    debug.armures = portees.map(P => P.armure);
  }
  const alterArmure = st => (armure > 0 && ORDRE_DIESES.slice(0, armure).includes(st)) ? 1 : (armure < 0 && ORDRE_BEMOLS.slice(0, -armure).includes(st)) ? -1 : 0;

  const tokens = [], evenements = [], mesures = [];
  let mesure = { evs: [], duree: 0 };
  choix.forEach((P, k) => {
    let cle = opts.cle && opts.cle !== 'auto' ? opts.cle : (P.cle || (P.role === 'bas' || opts.main === 'gauche' ? 'fa' : 'sol'));
    const base = cle === 'fa' ? 2 * 7 + 4 : 4 * 7 + 2; // ligne du bas : Sol2 ou Mi4
    let accMes = {};
    const evs = lirePortee(P, opts.main !== 'gauche');
    evs.forEach((e, i) => {
      if (e.type === 'barre') {
        if (mesure.evs.length) { mesures.push(mesure); mesure = { evs: [], duree: 0 }; }
        accMes = {}; return;
      }
      if (e.type === 'silence') { mesure.evs.push(e); mesure.duree += e.dur; return; }
      const d = base + e.p, st = STEPS[((d % 7) + 7) % 7], oct = Math.floor(d / 7);
      let alter = alterArmure(st);
      if (e.alteration) { alter = e.alteration === 'diese' ? 1 : e.alteration === 'bemol' ? -1 : 0; accMes[d] = alter; }
      else if (accMes[d] !== undefined) alter = accMes[d];
      e.d = d;
      e.midi = (oct + 1) * 12 + PC[STEPS.indexOf(st)] + alter;
      e.nom = NOMS_FR[st] + (alter === 1 ? '#' : alter === -1 ? 'b' : '') + oct;
      e.cle = cle;
      mesure.evs.push(e); mesure.duree += e.dur;
    });
    // fin de système = fin de mesure
    if (mesure.evs.length) { mesures.push(mesure); mesure = { evs: [], duree: 0 }; }
  });
  if (mesure.evs.length) mesures.push(mesure);

  // liaisons de prolongation : arc fin entre deux notes consécutives de même hauteur
  const fins = new Map();
  const estFin = id => {
    if (fins.has(id)) return fins.get(id);
    const c = comps[id - 1]; const ok = !avecTete.has(id) && c.h <= 1.25 * c.s0 && c.w >= 0.3 * c.s0 && c.n / (c.w * c.h) < 0.6;
    fins.set(id, ok); return ok;
  };
  comps.forEach(c => { const P = porteeDe(c); c.s0 = P ? P.s : est.s; });
  const couverture = (y, s, xa, xb, xmin, xmax) => {
    xa = Math.round(xa); xb = Math.round(xb);
    if (xb - xa < 2) return 0;
    let meilleur = 0;
    for (const sens of [-1, 1]) {
      let n = 0;
      for (let x = xa; x <= xb; x++) {
        let vu = false;
        for (let dy = 0.3 * s; dy <= 1.7 * s && !vu; dy += 1) {
          const yy = Math.round(y + sens * dy); if (yy < 0 || yy >= h) continue;
          const id = lab[yy * w + x];
          if (id && estFin(id)) { const c = comps[id - 1]; if (c.x1 >= xmin && c.x0 <= xmax) vu = true; }
        }
        if (vu) n++;
      }
      meilleur = Math.max(meilleur, n / (xb - xa + 1));
    }
    return meilleur;
  };
  const toutes = mesures.flatMap(m => m.evs);
  for (let i = 0; i + 1 < toutes.length; i++) {
    const A = toutes[i], B = toutes[i + 1];
    if (A.type !== 'note' || B.type !== 'note' || A.d !== B.d || A.cle !== B.cle) continue;
    const s = A.P.s;
    let liee = false;
    if (A.P === B.P) {
      liee = couverture(A.y, s, A.x + 0.7 * s, B.x - 0.7 * s, A.x - 0.9 * s, B.x + 0.9 * s) >= 0.55;
    } else {
      const fa = couverture(A.y, s, A.x + 0.7 * s, Math.min(A.x + 3 * s, A.P.droite), A.x - 0.9 * s, A.P.droite + s);
      const fb = couverture(B.y, B.P.s, Math.max(B.P.debutMusique, B.x - 3 * B.P.s), B.x - 0.7 * B.P.s, B.P.gauche, B.x + 0.9 * B.P.s);
      liee = fa >= 0.5 && fb >= 0.4;
    }
    if (liee) { A.lie = true; B.midi = A.midi; B.nom = A.nom; B.suiteLiee = true; }
  }

  // triolets : 3 croches (ou noires, doubles) avec un « 3 » tout près → durée × 2/3
  const estTrois = (c, s) => !avecTete.has(c.id) && !utilisees.has(c.id) && c.h >= 0.65 * s && c.h <= 1.9 * s && c.w >= 0.25 * s && c.w <= 1.4 * s && (c.n / (c.w * c.h) < 0.65 || c.w < 0.5 * s); // un « 3 » fin peut n'apparaître qu'en partie
  const marquerTriolets = (evs) => {
    const notes = evs.filter(e => e.type === 'note');
    for (let i = 0; i + 2 < notes.length; i++) {
      const [A, B, C] = [notes[i], notes[i + 1], notes[i + 2]];
      if (A.triolet || B.triolet || C.triolet || A.P !== C.P) continue;
      if (!(A.dur === B.dur && B.dur === C.dur && [0.25, 0.5, 1].includes(A.dur))) continue;
      const s = A.P.s, ys = [A, B, C].flatMap(e => [e.y, e.tete.hampe ? e.tete.hampe.bout : e.y]);
      const yMin = Math.min(...ys) - 2.6 * s, yMax = Math.max(...ys) + 2.6 * s;
      const trouve = parPortee.get(A.P).concat(comps.filter(c => c.y1 < A.P.haut - 2 * s || c.y0 > A.P.bas + 2 * s)).some(c => {
        if (!estTrois(c, s)) return false;
        const xc = (c.x0 + c.x1) / 2, yc = (c.y0 + c.y1) / 2;
        return xc > A.x - 0.4 * s && xc < C.x + 1.2 * s && Math.abs(xc - B.x) < 1.6 * s + (C.x - A.x) / 3 && yc > yMin && yc < yMax &&
          !(yc > Math.min(A.y, B.y, C.y) - 0.6 * s && yc < Math.max(A.y, B.y, C.y) + 0.6 * s); // pas au niveau des têtes
      });
      if (trouve) { [A, B, C].forEach(e => { e.dur = e.dur * 2 / 3; e.triolet = true; }); i += 2; }
    }
  };
  mesures.forEach(m => {
    marquerTriolets(m.evs);
    m.duree = m.evs.reduce((a, e) => a + e.dur, 0);
  });
  // « simile » : le 3 n'est imprimé qu'au début ; si une mesure est trop longue d'exactement ce que
  // des triolets expliqueraient, on transforme les groupes de 3 croches qui commencent sur un temps
  {
    const f0 = {}; mesures.forEach(m => { const k = Math.round(m.duree * 12) / 12; f0[k] = (f0[k] || 0) + 1; });
    const norm0 = +Object.keys(f0).sort((a, c) => f0[c] - f0[a] || c - a)[0] || 4;
    const yADesTriolets = mesures.some(m => m.evs.some(e => e.triolet));
    mesures.forEach(m => {
      let exces = m.duree - norm0;
      if (exces < 0.4 || !yADesTriolets && exces % 0.5 > 0.01) return;
      let t = 0;
      for (let i = 0; i + 2 < m.evs.length && exces > 0.4; i++) {
        const [A, B, C] = m.evs.slice(i, i + 3);
        const surTemps = Math.abs(t - Math.round(t)) < 0.01;
        if (surTemps && [A, B, C].every(e => e.type === 'note' && !e.triolet && e.dur === 0.5)) {
          [A, B, C].forEach(e => { e.dur = 1 / 3; e.triolet = true; }); exces -= 0.5; t += 1; i += 2; continue;
        }
        t += m.evs[i].dur;
      }
      m.duree = m.evs.reduce((a, e) => a + e.dur, 0);
    });
  }

  // silence mal identifié (soupir lu au lieu d'un demi-soupir / quart de soupir) : si la mesure est trop
  // longue d'exactement la différence, on raccourcit le silence
  {
    const f1 = {}; mesures.forEach(m => { const k = Math.round(m.duree * 12) / 12; f1[k] = (f1[k] || 0) + 1; });
    const norm1 = +Object.keys(f1).sort((a, c) => f1[c] - f1[a] || c - a)[0] || 4;
    mesures.forEach(m => {
      const exces = m.duree - norm1;
      if (exces < 0.2) return;
      const r = m.evs.find(e => e.type === 'silence' && e.dur === 1 && [0.25, 0.5].some(d => Math.abs(e.dur - d - exces) < 0.02));
      if (r) { r.dur -= exces; m.duree -= exces; }
    });
  }

  // point oublié : mesure trop courte d'exactement une double-croche, avec « croche + double » → croche pointée
  {
    const f2 = {}; mesures.forEach(m => { const k = Math.round(m.duree * 12) / 12; f2[k] = (f2[k] || 0) + 1; });
    const norm2 = +Object.keys(f2).sort((a, c) => f2[c] - f2[a] || c - a)[0] || 4;
    mesures.forEach((m, mi) => {
      const manque = norm2 - m.duree;
      if (mi === 0 || mi === mesures.length - 1 || manque < 0.2) return;
      for (let i = 0; i + 1 < m.evs.length; i++) {
        const e = m.evs[i], suiv = m.evs[i + 1];
        if (e.type === 'note' && !e.triolet && Math.abs(e.dur - 2 * manque) < 0.01 && Math.abs(suiv.dur - manque) < 0.01) {
          e.dur *= 1.5; m.duree += manque; break;
        }
      }
    });
  }

  // mesure "normale" = durée la plus fréquente
  const freq = {}; mesures.forEach(m => { const k = Math.round(m.duree * 12) / 12; freq[k] = (freq[k] || 0) + 1; });
  const normale = +Object.keys(freq).sort((a, c) => freq[c] - freq[a] || c - a)[0] || 4;
  const codeDuree = d => {
    const t = [[4, '1'], [3, '2.'], [2, '2'], [1.5, '4.'], [1, '4'], [0.75, '8.'], [0.5, '8'], [0.375, '16.'], [0.25, '16'], [0.125, '32'],
      [4 / 3, '2t'], [2 / 3, '4t'], [1 / 3, '8t'], [1 / 6, '16t']];
    const m = t.find(([v]) => Math.abs(v - d) < 0.01);
    return m ? m[1] : '4';
  };
  mesures.forEach((m, i) => {
    m.douteuse = Math.abs(m.duree - normale) > 0.02 && !(i === 0 && m.duree < normale) && !(i === mesures.length - 1 && m.duree < normale);
    if (i) tokens.push('|');
    m.evs.forEach(e => {
      // un silence d'une ronde seul dans la mesure = pause de mesure entière
      const dur = e.type === 'silence' && e.dur === 4 && m.evs.length === 1 ? normale : e.dur;
      tokens.push((e.type === 'silence' ? 'R' : e.nom) + '/' + codeDuree(dur) + (e.lie ? '~' : ''));
      evenements.push(e);
    });
  });
  // simplifie : on n'écrit la durée que quand elle change
  let derniere = null;
  const texte = tokens.map(tk => {
    if (tk === '|') return tk;
    const lie = tk.endsWith('~'), [n, d] = tk.replace('~', '').split('/');
    if (d === derniere) return n + (lie ? '~' : '');
    derniere = d; return tk;
  }).join(' ');

  return {
    texte, mesures, evenements, portees, piano, armure, choix,
    tempsParMesure: normale,
    cles: choix.map(P => P.cle),
    nbNotes: evenements.filter(e => e.type === 'note').length,
    nbDouteuses: mesures.filter(m => m.douteuse).length,
    accords: evenements.filter(e => e.accord).length >= 2,
    G, debug, tetes: T, silences, barres,
  };
}

// Dessine l'image (redressée) et ce qui a été reconnu, pour vérification
function dessiner(cv, R, opts = {}) {
  const G = R.G, w = G.w, h = G.h;
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  const im = cx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { const v = G.g[i]; im.data[4 * i] = im.data[4 * i + 1] = im.data[4 * i + 2] = 160 + v * 0.37; im.data[4 * i + 3] = 255; }
  cx.putImageData(im, 0, 0);
  const choisies = new Set(R.choix || []);
  (R.portees || []).forEach(P => {
    cx.strokeStyle = choisies.has(P) ? 'rgba(61,90,128,.55)' : 'rgba(150,150,150,.35)'; cx.lineWidth = 1;
    P.lignes.forEach(y => { cx.beginPath(); cx.moveTo(P.gauche, y); cx.lineTo(P.droite, y); cx.stroke(); });
  });
  const fs = Math.max(12, Math.round((R.debug.interligne || 12) * 1.25));
  cx.font = `bold ${fs}px system-ui, sans-serif`; cx.textAlign = 'center';
  (R.mesures || []).forEach(m => {
    m.evs.forEach(e => {
      const s = e.P.s;
      if (e.type === 'note') {
        cx.strokeStyle = m.douteuse ? '#e8a33d' : '#2e8b57'; cx.lineWidth = Math.max(2, s * 0.15);
        cx.beginPath(); cx.ellipse(e.x, e.y, 0.75 * s, 0.6 * s, 0, 0, 2 * Math.PI); cx.stroke();
        const label = e.nom.replace(/\d+$/, '');
        const ly = e.P.bas + 2.4 * s + (opts.decaler ? 0 : 0);
        cx.fillStyle = m.douteuse ? '#b86e00' : '#1f6b40'; cx.fillText(label, e.x, ly);
        if (e.lie) { cx.strokeStyle = '#2e8b57'; cx.beginPath(); cx.moveTo(e.x + 0.6 * s, e.P.bas + 1.6 * s); cx.lineTo(e.x + 1.6 * s, e.P.bas + 1.6 * s); cx.stroke(); cx.fillText('⌒', e.x + 1.1 * s, e.P.bas + 1.5 * s); }
      } else if (e.type === 'silence') {
        cx.strokeStyle = '#7b4fb5'; cx.lineWidth = Math.max(2, s * 0.12);
        cx.strokeRect(e.x - 0.6 * s, e.P.haut + 0.3 * s, 1.2 * s, 3.4 * s);
      }
    });
  });
  (R.choix || []).forEach(P => (R.barres.get(P) || []).forEach(x => {
    cx.strokeStyle = 'rgba(209,73,91,.7)'; cx.lineWidth = 2; cx.beginPath(); cx.moveTo(x, P.haut - P.s); cx.lineTo(x, P.bas + P.s); cx.stroke();
  }));
}

global.OMR = { versGris, analyser, dessiner, redimensionner, binariser, estimerInterligne, trouverPortees };
})(typeof window !== 'undefined' ? window : globalThis);
