/* ================================================================
   CarSpecs — منطق التطبيق الكامل
   + ميزة تفاصيل السيارة (CarQuery + NHTSA Safety)
   ================================================================ */

const API = "https://vpic.nhtsa.dot.gov/api/vehicles";
const CQ_API = "https://www.carqueryapi.com/api/0.3/";
const NHTSA_SAFETY = "https://api.nhtsa.gov/SafetyRatings";

/* ===== الحالة ===== */
const state = {
  makes: [],
  currentMake: null,
  currentModels: [],
};

/* ===== أدوات DOM ===== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* ===== أدوات مساعدة ===== */
const escapeHTML = (str) =>
  String(str ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));

const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

async function apiGet(path) {
  const res = await fetch(`${API}/${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 9999;
}

/* ===== Toast ===== */
let toastTimer;
function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ================================================================
   JSONP (للتعامل مع CarQuery API الذي يدعم JSONP فقط)
   ================================================================ */
function jsonp(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const cbName = "cq_" + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("انتهت مهلة الاتصال"));
    }, timeoutMs);

    function cleanup() {
      try { delete window[cbName]; } catch { window[cbName] = undefined; }
      const script = document.getElementById(cbName);
      if (script) script.remove();
      clearTimeout(timer);
    }

    window[cbName] = (data) => {
      cleanup();
      resolve(data);
    };

    const script = document.createElement("script");
    script.src = `${url}&callback=${cbName}`;
    script.id = cbName;
    script.onerror = () => { cleanup(); reject(new Error("فشل تحميل البيانات")); };
    document.body.appendChild(script);
  });
}

/* ================================================================
   جلب مواصفات السيارة من CarQuery + NHTSA Safety
   ================================================================ */
const SPECS_CACHE = new Map();

async function fetchCarSpecs(makeName, modelName) {
  const cacheKey = `${makeName}::${modelName}`.toLowerCase();
  if (SPECS_CACHE.has(cacheKey)) return SPECS_CACHE.get(cacheKey);

  const result = { trims: [], safety: null, error: null };

  // 1) CarQuery — جلب الفئات (Trims) مع المواصفات
  try {
    const params = new URLSearchParams({
      cmd: "getTrims",
      make: makeName.toLowerCase().replace(/\s+/g, "_"),
      model: modelName.toLowerCase().replace(/\s+/g, "_"),
      full_results: "1",
    });
    const data = await jsonp(`${CQ_API}?${params.toString()}`);
    if (data && Array.isArray(data.Trims)) {
      result.trims = data.Trims;
    }
  } catch (e) {
    console.warn("CarQuery failed:", e.message);
  }

  // 2) NHTSA Safety Ratings — جلب تصنيفات الأمان
  // يحتاج سنة، لذلك نأخذ السنوات من آخر 3 سنوات
  try {
    const currentYear = new Date().getFullYear();
    for (let y = currentYear; y >= currentYear - 3; y--) {
      const url = `${NHTSA_SAFETY}/modelyear/${y}/make/${encodeURIComponent(makeName)}/model/${encodeURIComponent(modelName)}?format=json`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (data.Count > 0 && data.Results && data.Results.length) {
        result.safety = { year: y, vehicle: data.Results[0] };
        break;
      }
    }
  } catch (e) {
    console.warn("NHTSA Safety failed:", e.message);
  }

  SPECS_CACHE.set(cacheKey, result);
  return result;
}

async function fetchSafetyDetails(vehicleId) {
  try {
    const res = await fetch(`${NHTSA_SAFETY}/VehicleId/${vehicleId}?format=json`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.Results?.[0] || null;
  } catch {
    return null;
  }
}

/* ================================================================
   عرض تفاصيل السيارة في Modal
   ================================================================ */
async function showCarDetails(makeName, modelName) {
  const modal = document.getElementById("details-modal");
  const body = document.getElementById("modal-body");
  const title = document.getElementById("modal-title");
  const subtitle = document.getElementById("modal-subtitle");

  title.textContent = `${makeName} ${modelName}`;
  subtitle.textContent = "جارٍ تحميل المواصفات…";

  // Skeleton
  body.innerHTML = `
    <div class="modal-skeleton">
      <div class="spinner"></div>
      <p>جارٍ جلب المواصفات التقنية…</p>
    </div>
  `;

  modal.showModal();

  // جلب البيانات
  const specs = await fetchCarSpecs(makeName, modelName);

  if (!specs.trims.length && !specs.safety) {
    renderEmptyState(body, makeName, modelName);
    return;
  }

  const imgURL = getModelImageURL(makeName, modelName);
  subtitle.textContent = `${makeName} • ${modelName}`;

  let html = "";

  // Hero image
  html += `
    <div class="details-hero">
      <img src="${imgURL}" alt="${escapeHTML(modelName)}"
           onerror="this.style.display='none'">
      <div class="details-hero-title">${escapeHTML(makeName)} ${escapeHTML(modelName)}</div>
    </div>
  `;

  // Badges
  const badges = [];
  if (specs.safety) {
    const rating = specs.safety.vehicle?.OverallRating;
    if (rating && rating !== "Not Rated") {
      badges.push(`<span class="detail-badge success">🛡️ أمان ${rating}★ — ${specs.safety.year}</span>`);
    }
  }
  badges.push(`<span class="detail-badge primary">🧩 ${specs.trims.length} فئة متوفرة</span>`);
  if (badges.length) {
    html += `<div class="details-badges">${badges.join("")}</div>`;
  }

  // قسم المحرك (من أول trim أو البحث عن حقول المحرك)
  const firstTrim = specs.trims[0] || {};
  const engineSection = buildEngineSection(firstTrim);
  if (engineSection) html += engineSection;

  // قسم الأداء
  const perfSection = buildPerformanceSection(firstTrim);
  if (perfSection) html += perfSection;

  // قسم الأبعاد والوزن
  const dimSection = buildDimensionsSection(firstTrim);
  if (dimSection) html += dimSection;

  // قسم استهلاك الوقود
  const fuelSection = buildFuelSection(firstTrim);
  if (fuelSection) html += fuelSection;

  // قسم الأمان
  if (specs.safety && specs.safety.vehicle) {
    const safetyDetails = await fetchSafetyDetails(specs.safety.vehicle.VehicleId);
    if (safetyDetails) {
      html += buildSafetySection(safetyDetails, specs.safety.year);
    }
  }

  // قسم الفئات المتاحة (Trims)
  if (specs.trims.length > 1) {
    html += buildTrimsSection(specs.trims);
  }

  // أزرار الإجراءات
  const favId = `${makeName}::${modelName}`;
  const isFav = Favorites.has("model", favId);
  const shareText = `${makeName} ${modelName} — مواصفات كاملة على CarSpecs`;
  const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;

  html += `
    <div class="details-actions">
      <button class="btn secondary fav-toggle"
              data-fav-type="model"
              data-fav-id="${escapeHTML(favId)}">
        ${isFav ? "⭐ إزالة من المفضلة" : "☆ أضف للمفضلة"}
      </button>
      <a class="btn share" href="${shareUrl}" target="_blank" rel="noopener">
        🐦 شارك على X
      </a>
    </div>
  `;

  body.innerHTML = html;

  // ربط زر المفضلة داخل الـ modal
  const favBtn = body.querySelector(".fav-toggle");
  if (favBtn) {
    favBtn.addEventListener("click", () => {
      const isFav = Favorites.toggle("model", favId);
      favBtn.textContent = isFav ? "⭐ إزالة من المفضلة" : "☆ أضف للمفضلة";
      showToast(isFav ? "⭐ تمت الإضافة للمفضلة" : "تمت الإزالة من المفضلة");
      applyFavStates();
    });
  }
}

/* ===== دوال بناء الأقسام ===== */
function sectionHTML(icon, title, cells) {
  if (!cells.length) return "";
  return `
    <div class="detail-section">
      <div class="detail-section-title"><span class="ico">${icon}</span> ${title}</div>
      <div class="detail-grid">
        ${cells.map(c => `
          <div class="detail-cell">
            <div class="dt-label">${escapeHTML(c.label)}</div>
            <div class="dt-value">${escapeHTML(c.value)}</div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function buildEngineSection(t) {
  const cells = [];
  if (t.engine_cylinders) cells.push({ label: "عدد الأسطوانات", value: t.engine_cylinders });
  if (t.engine_type) cells.push({ label: "نوع المحرك", value: t.engine_type });
  if (t.engine_displacement) cells.push({ label: "سعة المحرك (لتر)", value: t.engine_displacement });
  if (t.engine_position) cells.push({ label: "موضع المحرك", value: t.engine_position });
  if (t.engine_valves_per_cyl) cells.push({ label: "صمامات/أسطوانة", value: t.engine_valves_per_cyl });
  if (t.engine_fuel) cells.push({ label: "نوع الوقود", value: t.engine_fuel });
  if (t.engine_dohc) cells.push({ label: "DOHC", value: t.engine_dohc === "1" ? "نعم" : "لا" });
  if (t.engine_turbo) cells.push({ label: "تيربو", value: t.engine_turbo === "1" ? "نعم" : "لا" });
  if (t.engine_supercharged) cells.push({ label: "سوبر تشارج", value: t.engine_supercharged === "1" ? "نعم" : "لا" });
  return sectionHTML("🔧", "المحرك", cells);
}

function buildPerformanceSection(t) {
  const cells = [];
  if (t.model_engine_power_ps) cells.push({ label: "القوة (PS)", value: t.model_engine_power_ps });
  if (t.model_engine_power_rpm) cells.push({ label: "قوة عند RPM", value: t.model_engine_power_rpm });
  if (t.model_engine_torque_nm) cells.push({ label: "عزم الدوران (Nm)", value: t.model_engine_torque_nm });
  if (t.model_engine_torque_rpm) cells.push({ label: "عزم عند RPM", value: t.model_engine_torque_rpm });
  if (t.model_top_speed) cells.push({ label: "السرعة القصوى (كم/س)", value: t.model_top_speed });
  if (t.model_0_to_100_kph) cells.push({ label: "0-100 كم/س (ث)", value: t.model_0_to_100_kph });
  return sectionHTML("⚡", "الأداء والقوة", cells);
}

function buildDimensionsSection(t) {
  const cells = [];
  if (t.model_body) cells.push({ label: "نوع الهيكل", value: t.model_body });
  if (t.model_doors) cells.push({ label: "عدد الأبواب", value: t.model_doors });
  if (t.model_seats) cells.push({ label: "عدد المقاعد", value: t.model_seats });
  if (t.model_length_mm) cells.push({ label: "الطول (مم)", value: t.model_length_mm });
  if (t.model_width_mm) cells.push({ label: "العرض (مم)", value: t.model_width_mm });
  if (t.model_height_mm) cells.push({ label: "الارتفاع (مم)", value: t.model_height_mm });
  if (t.model_wheelbase_mm) cells.push({ label: "قاعدة العجلات (مم)", value: t.model_wheelbase_mm });
  if (t.model_weight_kg) cells.push({ label: "الوزن (كجم)", value: t.model_weight_kg });
  return sectionHTML("📏", "الأبعاد والهيكل", cells);
}

function buildFuelSection(t) {
  const cells = [];
  if (t.model_lkm_hwy) cells.push({ label: "استهلاك طريق سريع (ل/100كم)", value: t.model_lkm_hwy });
  if (t.model_lkm_mixed) cells.push({ label: "استهلاك مختلط (ل/100كم)", value: t.model_lkm_mixed });
  if (t.model_lkm_city) cells.push({ label: "استهلاك داخل المدينة (ل/100كم)", value: t.model_lkm_city });
  if (t.model_fuel_cap_l) cells.push({ label: "سعة خزان الوقود (لتر)", value: t.model_fuel_cap_l });
  if (t.model_co2) cells.push({ label: "انبعاثات CO₂", value: t.model_co2 });
  return sectionHTML("⛽", "استهلاك الوقود", cells);
}

function buildSafetySection(s, year) {
  const starsHTML = (n) => {
    const num = parseInt(n, 10) || 0;
    let html = "";
    for (let i = 1; i <= 5; i++) {
      html += `<span class="${i <= num ? "on" : "off"}">★</span>`;
    }
    return html;
  };

  const items = [];
  const add = (label, key) => {
    const v = s[key];
    if (v && v !== "Not Rated" && v !== "Not Applicable" && v !== "") {
      items.push(`<div class="safety-item">
        <div class="safety-label">${escapeHTML(label)}</div>
        <div class="safety-stars">${starsHTML(v)}</div>
      </div>`);
    }
  };

  add("التقييم العام", "OverallRating");
  add("الحماية الكلية - أمامي", "OverallFrontCrashRating");
  add("الحماية الكلية - جانبي", "OverallSideCrashRating");
  add("انقلاب", "RolloverRating");
  add("الوسائد الهوائية الأمامية", "FrontCrashDriversideRating");
  add("جانبي - السائق", "SideCrashDriversideRating");
  add("جانبي - الراكب", "SideCrashPassengersideRating");

  if (!items.length) return "";

  return `
    <div class="detail-section">
      <div class="detail-section-title"><span class="ico">🛡️</span> تصنيفات الأمان — ${year} (NHTSA)</div>
      <div class="safety-grid">${items.join("")}</div>
    </div>
  `;
}

function buildTrimsSection(trims) {
  return `
    <div class="detail-section">
      <div class="detail-section-title"><span class="ico">🧩</span> الفئات المتوفرة (${trims.length})</div>
      <div class="detail-grid">
        ${trims.map(t => `
          <div class="detail-cell">
            <div class="dt-label">${escapeHTML(t.model_trim || "—")}</div>
            <div class="dt-value">${escapeHTML(t.model_year || "")} • ${escapeHTML(t.model_engine_cc || "—")}cc</div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderEmptyState(body, makeName, modelName) {
  body.innerHTML = `
    <div class="modal-empty">
      <div class="empty-icon">🔍</div>
      <p>لم نجد مواصفات متقدمة لـ <strong>${escapeHTML(makeName)} ${escapeHTML(modelName)}</strong>.</p>
      <p style="font-size:.85rem;margin-top:8px;">جرّب استخدام رقم الهيكل (VIN) للحصول على تفاصيل أدق.</p>
      <button class="btn primary" style="margin-top:16px;" onclick="closeDetailsModal();showView('vin');">
        فك VIN
      </button>
    </div>
  `;
}

function closeDetailsModal() {
  const modal = document.getElementById("details-modal");
  if (modal && modal.open) modal.close();
}

/* ================================================================
   صور السيارات
   ================================================================ */
const MAKE_DOMAINS = {
  "toyota": "toyota.com", "honda": "honda.com", "bmw": "bmw.com",
  "mercedes-benz": "mercedes-benz.com", "mercedes": "mercedes-benz.com",
  "ford": "ford.com", "chevrolet": "chevrolet.com",
  "nissan": "nissan-global.com", "hyundai": "hyundai.com",
  "kia": "kia.com", "tesla": "tesla.com", "audi": "audi.com",
  "volkswagen": "vw.com", "vw": "vw.com", "porsche": "porsche.com",
  "ferrari": "ferrari.com", "lamborghini": "lamborghini.com",
  "mazda": "mazda.com", "subaru": "subaru.com",
  "mitsubishi": "mitsubishi-motors.com", "volvo": "volvocars.com",
  "jaguar": "jaguar.com", "land rover": "landrover.com",
  "peugeot": "peugeot.com", "renault": "renault.com",
  "citroen": "citroen.com", "fiat": "fiat.com", "jeep": "jeep.com",
  "dodge": "dodge.com", "chrysler": "chrysler.com",
  "cadillac": "cadillac.com", "buick": "buick.com", "gmc": "gmc.com",
  "lexus": "lexus.com", "infiniti": "infiniti.com",
  "acura": "acura.com", "genesis": "genesis.com", "mini": "miniusa.com",
  "bentley": "bentleymotors.com", "rolls-royce": "rolls-roycemotorcars.com",
  "aston martin": "astonmartin.com", "maserati": "maserati.com",
  "alfa romeo": "alfaromeo.com", "bugatti": "bugatti.com",
  "mclaren": "mclaren.com", "lotus": "lotuscars.com",
  "ram": "ramtrucks.com", "lincoln": "lincoln.com",
  "suzuki": "globalsuzuki.com", "isuzu": "isuzu.com",
  "skoda": "skoda-auto.com", "seat": "seat.com", "opel": "opel.com",
  "polestar": "polestar.com", "rivian": "rivian.com",
  "lucid": "lucidmotors.com", "byd": "byd.com", "geely": "geely.com",
  "chery": "cheryinternational.com", "mahindra": "mahindra.com",
  "tata": "tatamotors.com",
};

function getMakeLogoURL(makeName) {
  const key = makeName.toLowerCase().trim();
  const domain = MAKE_DOMAINS[key]
    || key.replace(/\s+/g, "").replace(/[^a-z0-9]/g, "") + ".com";
  return `https://logo.clearbit.com/${domain}?size=200`;
}

function getModelImageURL(makeName, modelName) {
  const seed = hashCode(`${makeName}-${modelName}`);
  const make = encodeURIComponent(makeName.toLowerCase().replace(/\s+/g, ""));
  const model = encodeURIComponent(modelName.toLowerCase().replace(/\s+/g, ""));
  return `https://loremflickr.com/800/500/${make},${model}/all?lock=${seed}`;
}

/* ================================================================
   المفضلة (localStorage)
   ================================================================ */
const FAV_KEY = "carspecs:favorites";

const Favorites = {
  getAll() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
    catch { return []; }
  },
  save(list) {
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
    this.updateBadge();
  },
  has(type, id) {
    return this.getAll().some(f => f.type === type && f.id === id);
  },
  toggle(type, id) {
    const list = this.getAll();
    const idx = list.findIndex(f => f.type === type && f.id === id);
    if (idx >= 0) {
      list.splice(idx, 1);
      this.save(list);
      return false;
    }
    list.push({ type, id, addedAt: Date.now() });
    this.save(list);
    return true;
  },
  clear() { this.save([]); },
  updateBadge() {
    const badge = document.getElementById("fav-count");
    if (!badge) return;
    const count = this.getAll().length;
    if (count > 0) { badge.textContent = count; badge.hidden = false; }
    else { badge.hidden = true; }
  },
};

function applyFavStates() {
  document.querySelectorAll(".fav-btn").forEach(btn => {
    const type = btn.dataset.favType;
    const id = btn.dataset.favId;
    if (Favorites.has(type, id)) btn.classList.add("active");
    else btn.classList.remove("active");
  });
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".fav-btn");
  if (!btn) return;
  e.stopPropagation();
  e.preventDefault();

  const type = btn.dataset.favType;
  const id = btn.dataset.favId;
  const isFav = Favorites.toggle(type, id);

  btn.classList.toggle("active", isFav);
  btn.classList.add("just-clicked");
  setTimeout(() => btn.classList.remove("just-clicked"), 350);
  showToast(isFav ? "⭐ تمت الإضافة للمفضلة" : "تمت الإزالة من المفضلة");

  if (document.querySelector("#view-favorites.active")) renderFavorites();
});

/* ================================================================
   التنقل
   ================================================================ */
function showView(name) {
  $$(".view").forEach(v => v.classList.remove("active"));
  const view = $(`#view-${name}`);
  if (!view) return;
  view.classList.add("active");
  $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  if (name === "favorites") renderFavorites();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goHome(e) {
  if (e) e.preventDefault();
  showView("home");
}

/* ================================================================
   الماركات
   ================================================================ */
async function loadMakes() {
  if (state.makes.length) return state.makes;
  const loadingEl = $("#makes-loading");
  if (loadingEl) loadingEl.style.display = "block";

  try {
    const data = await apiGet("getallmakes?format=json");
    const all = data.Results || [];
    const seen = new Set();
    const cleaned = [];
    for (const m of all) {
      const name = (m.Make_Name || "").trim();
      if (!name || name.length > 40) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push({ name, id: m.Make_ID });
    }
    cleaned.sort((a, b) => a.name.localeCompare(b.name));
    state.makes = cleaned;
    renderMakes(cleaned, "#all-makes");
    renderPopular(cleaned);
    const countEl = $("#makes-count");
    if (countEl) countEl.textContent = `${cleaned.length} ماركة`;
    return cleaned;
  } catch (err) {
    console.error(err);
    if (loadingEl) loadingEl.textContent = "⚠️ فشل تحميل الماركات. تحقق من اتصالك.";
    return [];
  } finally {
    if (loadingEl) loadingEl.style.display = "none";
  }
}

function makeCardHTML(make) {
  const logoURL = getMakeLogoURL(make.name);
  const initial = make.name.charAt(0).toUpperCase();
  const isFav = Favorites.has("make", make.name);

  return `
    <div class="make-card" data-make="${escapeHTML(make.name)}">
      <button class="fav-btn ${isFav ? 'active' : ''}"
              data-fav-type="make"
              data-fav-id="${escapeHTML(make.name)}"
              aria-label="أضف للمفضلة">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M12 21s-7-4.35-9-9.5C1.5 7 4 4 7 4c1.5 0 3 .8 4 2 1-1.2 2.5-2 4-2 3 0 5.5 3 4 7.5C19 16.65 12 21 12 21z"
                fill="${isFav ? '#fff' : 'none'}" stroke="currentColor" stroke-width="2"/>
        </svg>
      </button>
      <div class="make-logo-wrap">
        <img class="make-logo"
             src="${logoURL}"
             alt="${escapeHTML(make.name)}"
             loading="lazy"
             onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'make-logo-fallback',textContent:'${initial}'}))">
      </div>
      <div class="make-info">
        <div class="make-name">${escapeHTML(make.name)}</div>
      </div>
    </div>
  `;
}

function renderMakes(makes, selector) {
  const grid = $(selector);
  if (!grid) return;
  grid.innerHTML = makes.map(makeCardHTML).join("");
  grid.querySelectorAll(".make-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".fav-btn")) return;
      openMake(card.dataset.make);
    });
  });
  applyFavStates();
}

function renderPopular(makes) {
  const popular = [
    "Toyota", "Honda", "BMW", "Mercedes-Benz", "Ford", "Chevrolet",
    "Nissan", "Hyundai", "Kia", "Tesla", "Audi", "Volkswagen"
  ];
  const list = popular
    .map(name => makes.find(m => m.name.toLowerCase() === name.toLowerCase()))
    .filter(Boolean);
  const finalList = list.length >= 6 ? list : makes.slice(0, 12);
  renderMakes(finalList, "#popular-makes");
}

/* ================================================================
   الموديلات
   ================================================================ */
async function openMake(makeName) {
  state.currentMake = makeName;
  showView("models");

  $("#models-title").textContent = `موديلات ${makeName}`;
  $("#models-count").textContent = "";
  $("#models-grid").innerHTML = "";
  $("#models-loading").style.display = "block";

  try {
    const data = await apiGet(`GetModelsForMake/${encodeURIComponent(makeName)}?format=json`);
    const models = data.Results || [];
    const seen = new Set();
    const cleaned = [];
    for (const m of models) {
      const name = (m.Model_Name || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push({ name, make: m.Make_Name || makeName });
    }
    cleaned.sort((a, b) => a.name.localeCompare(b.name));
    state.currentModels = cleaned;
    renderModels(cleaned);
    $("#models-count").textContent = `${cleaned.length} موديل`;
  } catch (err) {
    console.error(err);
    $("#models-loading").textContent = "⚠️ فشل تحميل الموديلات.";
  } finally {
    $("#models-loading").style.display = "none";
  }
}

function modelCardHTML(m) {
  const makeName = m.make || state.currentMake || "";
  const imgURL = getModelImageURL(makeName, m.name);
  const favId = `${makeName}::${m.name}`;
  const isFav = Favorites.has("model", favId);

  return `
    <div class="model-card" data-make="${escapeHTML(makeName)}" data-model="${escapeHTML(m.name)}">
      <button class="fav-btn ${isFav ? 'active' : ''}"
              data-fav-type="model"
              data-fav-id="${escapeHTML(favId)}"
              aria-label="أضف للمفضلة">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M12 21s-7-4.35-9-9.5C1.5 7 4 4 7 4c1.5 0 3 .8 4 2 1-1.2 2.5-2 4-2 3 0 5.5 3 4 7.5C19 16.65 12 21 12 21z"
                fill="${isFav ? '#fff' : 'none'}" stroke="currentColor" stroke-width="2"/>
        </svg>
      </button>
      <div class="model-image-wrap">
        <div class="img-skeleton"></div>
        <img class="model-image"
             src="${imgURL}"
             alt="${escapeHTML(m.name)}"
             loading="lazy"
             onload="this.previousElementSibling && this.previousElementSibling.remove()"
             onerror="this.previousElementSibling && this.previousElementSibling.remove(); this.style.display='none'">
      </div>
      <div class="model-info">
        <div class="model-name">${escapeHTML(m.name)}</div>
        <div class="model-meta">${escapeHTML(makeName)}</div>
        <div class="details-hint">
          <span>عرض المواصفات الكاملة</span>
          <span class="arrow">←</span>
        </div>
      </div>
    </div>
  `;
}

function renderModels(models) {
  const grid = $("#models-grid");
  if (!models.length) {
    grid.innerHTML = `<p style="color:var(--muted)">لا توجد موديلات متاحة لهذه الماركة.</p>`;
    return;
  }
  grid.innerHTML = models.map(modelCardHTML).join("");
  grid.querySelectorAll(".model-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".fav-btn")) return;
      showCarDetails(card.dataset.make, card.dataset.model);
    });
  });
  applyFavStates();
}

/* ================================================================
   البحث
   ================================================================ */
async function performSearch(query) {
  const q = query.trim().toLowerCase();
  const resultsEl = $("#search-results");
  if (!q) {
    resultsEl.classList.remove("show");
    resultsEl.innerHTML = "";
    return;
  }
  const makes = await loadMakes();
  const matches = makes.filter(m => m.name.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) {
    resultsEl.innerHTML = `<div class="result-item"><span>لا توجد نتائج</span></div>`;
  } else {
    resultsEl.innerHTML = matches.map(m => `
      <div class="result-item" data-make="${escapeHTML(m.name)}">
        <strong>${escapeHTML(m.name)}</strong>
        <span>عرض الموديلات →</span>
      </div>
    `).join("");
    resultsEl.querySelectorAll(".result-item").forEach(el => {
      el.addEventListener("click", () => {
        if (el.dataset.make) openMake(el.dataset.make);
      });
    });
  }
  resultsEl.classList.add("show");
}

/* ================================================================
   فك VIN
   ================================================================ */
async function decodeVIN(vin) {
  vin = vin.trim().toUpperCase();
  const resultEl = $("#vin-result");
  if (vin.length !== 17) {
    resultEl.innerHTML = `<p style="color:#ef4444">⚠️ رقم VIN يجب أن يكون 17 حرفًا.</p>`;
    return;
  }
  resultEl.innerHTML = `<div class="loading">جارٍ فك التشفير…</div>`;
  try {
    const data = await apiGet(`decodevin/${encodeURIComponent(vin)}?format=json`);
    const results = data.Results || [];
    const keysToShow = [
      "Make", "Model", "Model Year", "Vehicle Type", "Body Class",
      "Doors", "Seat Belts", "Engine Number of Cylinders",
      "Displacement (L)", "Engine Power (kW)", "Fuel Type - Primary",
      "Transmission Style", "Drive Type", "Brake System Type",
      "Anti-lock Braking System (ABS)", "Air Bag Loc Front",
      "Air Bag Loc Side", "Electronic Stability Control (ESC)",
      "Traction Control", "Tire Pressure Monitoring System (TPMS) Type",
      "Manufacturer Name", "Plant Country", "Series", "Trim",
      "GVWR", "Curb Weight (lbs)", "Wheel Base (inches)"
    ];
    const fields = [];
    for (const key of keysToShow) {
      const item = results.find(r => r.Variable === key);
      if (item && item.Value && item.Value !== "Not Applicable") {
        fields.push({ k: key, v: item.Value });
      }
    }
    if (!fields.length) {
      resultEl.innerHTML = `<p style="color:var(--muted)">لم نجد تفاصيل كافية لهذا الـ VIN.</p>`;
      return;
    }
    resultEl.innerHTML = `
      <h3 style="margin-bottom:16px">المواصفات المستخرجة (${fields.length})</h3>
      <div class="vin-grid">
        ${fields.map(f => `
          <div class="vin-item">
            <div class="k">${escapeHTML(f.k)}</div>
            <div class="v">${escapeHTML(f.v)}</div>
          </div>
        `).join("")}
      </div>
    `;
  } catch (err) {
    console.error(err);
    resultEl.innerHTML = `<p style="color:#ef4444">⚠️ فشل فك التشفير. جرب مرة أخرى.</p>`;
  }
}

/* ================================================================
   صفحة المفضلة
   ================================================================ */
function renderFavorites() {
  const grid = document.getElementById("favorites-grid");
  const empty = document.getElementById("favorites-empty");
  const clearBtn = document.getElementById("clear-favs");
  if (!grid || !empty) return;
  const list = Favorites.getAll();
  if (!list.length) {
    grid.innerHTML = "";
    empty.hidden = false;
    if (clearBtn) clearBtn.style.display = "none";
    return;
  }
  empty.hidden = true;
  if (clearBtn) clearBtn.style.display = "";
  const makes = list.filter(f => f.type === "make");
  const models = list.filter(f => f.type === "model");
  const cards = [];
  for (const fav of makes) cards.push(makeCardHTML({ name: fav.id, id: "—" }));
  for (const fav of models) {
    const [makeName, modelName] = fav.id.split("::");
    cards.push(modelCardHTML({ name: modelName, make: makeName }));
  }
  grid.innerHTML = cards.join("");
  grid.querySelectorAll(".make-card").forEach(c => {
    c.addEventListener("click", (e) => {
      if (e.target.closest(".fav-btn")) return;
      openMake(c.dataset.make);
    });
  });
  grid.querySelectorAll(".model-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".fav-btn")) return;
      showCarDetails(card.dataset.make, card.dataset.model);
    });
  });
  applyFavStates();
}

/* ================================================================
   الوضع الليلي
   ================================================================ */
function setupTheme() {
  const btn = $("#theme-btn");
  const saved = localStorage.getItem("theme");
  if (saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
    btn.textContent = "☀️";
  }
  btn.addEventListener("click", () => {
    document.documentElement.classList.toggle("dark");
    const isDark = document.documentElement.classList.contains("dark");
    btn.textContent = isDark ? "☀️" : "🌙";
    localStorage.setItem("theme", isDark ? "dark" : "light");
  });
}

/* ================================================================
   الإعداد
   ================================================================ */
function init() {
  const yearEl = $("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  setupTheme();

  $$(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });
  $$("[data-view]").forEach(el => {
    if (!el.classList.contains("nav-btn")) {
      el.addEventListener("click", () => showView(el.dataset.view));
    }
  });

  const clearBtn = document.getElementById("clear-favs");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (confirm("هل أنت متأكد من حذف جميع المفضلة؟")) {
        Favorites.clear();
        renderFavorites();
        applyFavStates();
        showToast("تم حذف كل المفضلة");
      }
    });
  }

  const searchInput = $("#search-input");
  searchInput.addEventListener("input", debounce(e => performSearch(e.target.value), 300));
  $("#search-btn").addEventListener("click", () => {
    const q = searchInput.value.trim();
    if (q) openMake(q);
  });
  searchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const q = searchInput.value.trim();
      if (q) openMake(q);
    }
  });
  document.addEventListener("click", e => {
    if (!e.target.closest(".search-box") && !e.target.closest(".search-results")) {
      $("#search-results").classList.remove("show");
    }
  });

  $("#makes-filter").addEventListener("input", debounce(e => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = q ? state.makes.filter(m => m.name.toLowerCase().includes(q)) : state.makes;
    renderMakes(filtered, "#all-makes");
  }, 200));

  $("#models-filter").addEventListener("input", debounce(e => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = q
      ? state.currentModels.filter(m => m.name.toLowerCase().includes(q))
      : state.currentModels;
    renderModels(filtered);
  }, 200));

  $("#vin-btn").addEventListener("click", () => decodeVIN($("#vin-input").value));
  $("#vin-input").addEventListener("keydown", e => {
    if (e.key === "Enter") decodeVIN($("#vin-input").value);
  });

  // إغلاق الـ Modal بالضغط على الخلفية أو ESC
  const detailsModal = document.getElementById("details-modal");
  if (detailsModal) {
    detailsModal.addEventListener("click", e => {
      if (e.target === detailsModal) detailsModal.close();
    });
    detailsModal.addEventListener("close", () => {
      // تنظيف المحتوى عند الإغلاق
      document.getElementById("modal-body").innerHTML = "";
    });
  }

  Favorites.updateBadge();
  loadMakes();
}

document.addEventListener("DOMContentLoaded", init);

/* جعل الدوال متاحة عالمياً للأزرار inline */
window.showView = showView;
window.goHome = goHome;
window.closeDetailsModal = closeDetailsModal;
window.showCarDetails = showCarDetails;