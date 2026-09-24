// ============================================================
// Brand reel specs — @golikov.psychologyst
// Canvas 720x1280 · content strip 720x404 centred
// Every cut lands on a strict 0.30 s grid (= the music beat).
// ============================================================
window.PALETTES = {
  p1: { name: "Смарагд + шампань",
        ink: "#0E2A22", ink2: "#174034", ink3: "#245A48",
        paper: "#F4EDDD", paper2: "#EDE3CE",
        gold: "#D8C08A", goldLite: "#F0E2BE", goldDeep: "#B99C5C" },
  p2: { name: "Пляшковий + старе золото",
        ink: "#14301F", ink2: "#1E472F", ink3: "#2D6442",
        paper: "#F2EEE2", paper2: "#E8E1CE",
        gold: "#C9A227", goldLite: "#EBD79A", goldDeep: "#A9871B" },
  p3: { name: "Темний мох + світле золото",
        ink: "#1B2D1F", ink2: "#28432E", ink3: "#3B5E42",
        paper: "#F6F1E4", paper2: "#EDE6D3",
        gold: "#E4D2A0", goldLite: "#F6EBCB", goldDeep: "#C3AC72" }
};

window.COMMON = {
  W: 720, H: 1280, STRIP_H: 404, STRIP_Y: 438,
  FPS: 30, STEP: 0.3,
  handle: "@golikov.psychologyst"
};

window.SPECS = {
  // ---------- Reel 1 — centred layout, three backgrounds ----------
  v1: {
    DURATION: 10.0,
    photo: "assets/sea.jpg",
    useSmoke: true,
    outroFrom: 6.0, outroOver: "paper", blackFlash: null,
    A: { lines: [["ТЕ,","ЩО","ТИ"],["ЛЮБИШ"],["МОРЕ"]],
         start: 0.0, from: 0.0, to: 2.7,
         font: "PF", weight: 700, size: 50, lh: 54, gap: ".255em",
         align: "flex-start", padLeft: 72, top: 120, anchor: "centre" },
    B: { lines: [["ще","не","означає,"],["що","мусиш"],["у","ньому","тонути"]],
         start: 2.7, from: 2.7, to: 10.0,
         font: "MT", weight: 700, size: 42, lh: 52, gap: ".265em",
         align: "center", padLeft: 0, top: 123, anchor: "centre" },
    // paper/photo alternate to 2.4, paper holds over the scene change, then smoke/paper
    bg: function (k) {
      if (k >= 20) return "outro";
      if (k >= 10) return (k % 2 === 0) ? "smoke" : "paper";
      if (k >= 8)  return "paper";
      return (k % 2 === 0) ? "paper" : "photo";
    }
  },

  // ---------- Reel 2 — left-aligned, top-anchored, two backgrounds ----------
  v2: {
    DURATION: 11.0,
    photo: "assets/meadow.jpg",
    overlay: "thread",
    useSmoke: false,
    outroFrom: 6.9, outroOver: "photo", blackFlash: 6.9,
    A: { lines: [["ТЕ,","ЩО","ТЕБЕ"],["НЕ","ВБИЛО"]],
         start: 0.0, from: 0.0, to: 2.1,
         font: "PF", weight: 700, size: 54, lh: 58.5, gap: ".255em",
         align: "flex-start", padLeft: 76, top: 70, anchor: "top" },
    B: { lines: [["буде","приходити"],["до","тебе","у","снах"],["щоразу,","коли","ти"],
                 ["вирішиш,","що","вже"],["відпустив"]],
         start: 2.1, from: 2.1, to: 11.0,
         font: "MT", weight: 700, size: 42, lh: 43.5, gap: ".265em",
         align: "flex-start", padLeft: 78, top: 72, anchor: "top" },
    // paper/photo alternate, paper holds over the scene change at k=6..7, then parity flips
    bg: function (k) {
      if (k >= 23) return "outro";
      if (k >= 8)  return (k % 2 === 0) ? "photo" : "paper";
      if (k === 7) return "paper";
      return (k % 2 === 0) ? "paper" : "photo";
    }
  }
};

// ---------- series: "переконання -> його ціна" ----------
// Same two-beat shape as reel 2 (type B): a line someone tells themselves,
// then what it costs. Everything but the words and the photo is shared.
(function () {
  function reelB(photo, A, B, overlay) {
    return {
      DURATION: 11.0, photo: photo, overlay: overlay || null, useSmoke: false,
      outroFrom: 6.9, outroOver: "photo", blackFlash: 6.9,
      A: { lines: A, start: 0.0, from: 0.0, to: 2.1,
           font: "PF", weight: 700, size: 54, lh: 58.5, gap: ".255em",
           align: "flex-start", padLeft: 76, top: 70, anchor: "top" },
      B: { lines: B, start: 2.1, from: 2.1, to: 11.0,
           font: "MT", weight: 700, size: 42, lh: 43.5, gap: ".265em",
           align: "flex-start", padLeft: 78, top: 72, anchor: "top" },
      bg: function (k) {
        if (k >= 23) return "outro";
        if (k >= 8)  return (k % 2 === 0) ? "photo" : "paper";
        if (k === 7) return "paper";
        return (k % 2 === 0) ? "paper" : "photo";
      }
    };
  }

  window.SPECS.t1 = reelB("assets/meadow.jpg",
    [["Я", "ЗМІНЮСЯ"]],
    [["і","ти","лишаєшся","чекати."],["це","не","терпіння,"],
     ["а","надія,","якою"],["тебе","тримають."]], "thread");

  window.SPECS.t2 = reelB("assets/sand.jpg",
    [["ВІН","НЕ"],["ХОТІВ"]],
    [["ти","захищаєш","того,"],["хто","зробив","боляче."],
     ["бо","визнати","намір"],["страшніше."]]);

  window.SPECS.t3 = reelB("assets/frost.jpg",
    [["ЗІ","МНОЮ"],["ВСЕ","ДОБРЕ"]],
    [["щоб","вижити,"],["довелося","не","відчувати."],
     ["тепер","не"],["відчувається","нічого."]]);

  window.SPECS.t4 = reelB("assets/fern.jpg",
    [["ЦЕ","МОЯ"],["ПРОВИНА"]],
    [["дитина","радше"],["вважатиме","поганою","себе,"],
     ["ніж","визнає,"],["що","її","не","любили."]]);

  window.SPECS.t5 = reelB("assets/wave.jpg",
    [["ТРЕБА","ПРОСТО"],["ВІДПУСТИТИ"]],
    [["не","відпускається"],["те,","що","не","прожите."],
     ["спершу","назвати,"],["і","лише","тоді","відпускати."]]);
})();
