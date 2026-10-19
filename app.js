const STORAGE_KEY = "personalInventoryApp.v2";
const LEGACY_KEY = "personalInventoryApp.v1";
const BACKUP_KEY = "personalInventoryApp.backups.v1";
const TUTORIAL_KEY = "personalInventoryApp.tutorial.v1";

const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});

const views = {
  calendar: "カレンダー",
  dashboard: "概要",
  register: "レジ",
  parts: "部品",
  products: "商品",
  venues: "出展イベント",
  purchases: "仕入・入荷",
  sales: "販売履歴",
  salesAnalysis: "販売分析",
  stockHistory: "在庫履歴",
  expenses: "費用一覧",
  management: "管理・集計",
  dataManagement: "データ管理",
};

let stateLoadError = null;
const state = loadState();
let registerCart = [];
let selectedRegisterItem = null;
let selectedRegisterCategory = "";
let registerLastCheckoutId = "";
let registerLastTotal = 0;
let undoStack = [];
let lastPersistedSnapshot = JSON.stringify(state);
let lastBackupSaved = true;
let tutorialIndex = 0;
let tutorialTarget = null;
let tutorialTargetHandler = null;
let pendingPurchasePartId = "";
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

const tutorialSteps = [
  { view: "dashboard", target: () => document.querySelector('[data-view="parts"]'), kind: "click", title: "部品画面を開きます", message: "次へを押すと部品画面へ移動します。" },
  { view: "parts", target: () => document.querySelector('#partForm [name="name"]'), kind: "input", title: "部品名を入力します", message: "ネジ、布、金具など、使う部品の名前を入力してください。" },
  { view: "parts", target: () => document.querySelector('#partForm [name="stock"]'), kind: "input", title: "現在の在庫を入力します", message: "今持っている数量を入力してください。" },
  { view: "parts", target: () => document.querySelector('#partForm button[type="submit"]'), kind: "save", title: "部品を保存します", message: "入力した部品を保存します。" },
  { view: "parts", target: () => document.querySelector('[data-view="products"]'), kind: "click", title: "商品画面を開きます", message: "次へを押すと商品画面へ移動します。" },
  { view: "products", target: () => document.querySelector('#productForm [name="name"]'), kind: "input", title: "商品名を入力します", message: "販売する商品の名前を入力してください。" },
  { view: "products", target: () => document.querySelector('#productForm [name="price"]'), kind: "input", title: "販売価格を入力します", message: "通常の販売価格を入力してください。" },
  { view: "products", target: () => document.querySelector('#productForm button[type="submit"]'), kind: "save", title: "商品を保存します", message: "商品を保存します。" },
  { view: "products", target: () => document.querySelector('[data-view="venues"]'), kind: "click", title: "イベント画面を開きます", message: "次へを押すと出展イベント画面へ移動します。" },
  { view: "venues", target: () => document.querySelector('#venueForm [name="eventName"]'), kind: "input", title: "イベント名を入力します", message: "マルシェ名やイベント名を入力してください。" },
  { view: "venues", target: () => document.querySelector('#venueForm [name="date"]'), kind: "input", title: "出展日を選びます", message: "出展する日付を選択してください。" },
  { view: "venues", target: () => document.querySelector('#venueForm [name="placeName"]'), kind: "input", title: "場所を入力します", message: "会場名や場所を入力してください。" },
  { view: "venues", target: () => document.querySelector('#venueForm button[type="submit"]'), kind: "save", title: "イベントを保存します", message: "入力したイベントを保存します。" },
  { target: () => null, kind: "done", title: "準備ができました", message: "これで基本登録は完了です。次はレジから販売を記録してみましょう。" },
];

document.addEventListener("DOMContentLoaded", async () => {
  await initStorage();
  setTodayDefaults();
  bindNavigation();
  bindSectionTabs();
  bindManagementTabs();
  bindCalendar();
  setupVenuePageTabs();
  setupVenueEditorTabs();
  setupVenueChecklist();
  bindForms();
  bindUtilityActions();
  addRecipeRow();
  renderAll();
  if (new URLSearchParams(location.search).get("demo") === "1"
    && !state.parts.length && !state.products.length && !state.venues.length && !state.sales.length) {
    window.__seedMakerDemo?.();
  }
  registerOfflineSupport();
  if (stateLoadError) {
    showToast("保存データを読み込めなかったため、安全のため空の状態で表示しています。バックアップまたはJSONから復元してください。");
  }
});

function loadState(stored = null) {
  const blank = {
    parts: [], products: [], venues: [], calendarEvents: [], sales: [], expenses: [],
    masters: { partCategories: ["レジン素材", "ビーズ", "金具", "梱包資材"], suppliers: [] },
    archivedParts: [], archivedProducts: [],
    stockAdjustments: [], operationLogs: [],
    users: [{ id: "owner", name: "管理者", role: "admin" }],
  };
  if (!stored) return blank;
  try {
    const parsed = { ...blank, ...(typeof stored === "string" ? JSON.parse(stored) : stored) };
    parsed.parts = parsed.parts.map(normalizePart);
    parsed.masters = normalizeMasters(parsed.masters, parsed.parts);
    parsed.products = parsed.products.map(normalizeProduct);
    parsed.archivedParts = Array.isArray(parsed.archivedParts) ? parsed.archivedParts.map(normalizePart) : [];
    parsed.archivedProducts = Array.isArray(parsed.archivedProducts) ? parsed.archivedProducts.map(normalizeProduct) : [];
    parsed.venues = parsed.venues.map(normalizeVenue);
    parsed.calendarEvents = Array.isArray(parsed.calendarEvents) ? parsed.calendarEvents.map(normalizeCalendarEvent) : [];
    parsed.sales = Array.isArray(parsed.sales) ? parsed.sales.map(normalizeSale) : [];
    parsed.expenses = Array.isArray(parsed.expenses) ? parsed.expenses.map(normalizeExpense) : [];
    parsed.stockAdjustments = Array.isArray(parsed.stockAdjustments) ? parsed.stockAdjustments : [];
    parsed.operationLogs = Array.isArray(parsed.operationLogs) ? parsed.operationLogs : [];
    parsed.users = Array.isArray(parsed.users) && parsed.users.length
      ? parsed.users.map((user) => ({ ...user, role: "admin" }))
      : [{ id: "owner", name: "管理者", role: "admin" }];
    return parsed;
  } catch (error) {
    stateLoadError = error;
    return blank;
  }
}

function normalizeMasters(masters, parts = []) {
  const source = masters && typeof masters === "object" ? masters : {};
  const unique = (values) => [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  const savedCategories = Array.isArray(source.partCategories) && source.partCategories.length
    ? source.partCategories
    : ["レジン素材", "ビーズ", "金具", "梱包資材"];
  const supplierMap = new Map();
  const addSupplier = (value) => {
    const supplier = typeof value === "string" ? { name: value } : value || {};
    const name = String(supplier.name || "").trim();
    if (!name) return;
    const current = supplierMap.get(name) || { id: supplier.id || uid("supplier"), name, address: "", memo: "" };
    supplierMap.set(name, {
      ...current,
      address: String(supplier.address || current.address || "").trim(),
      memo: String(supplier.memo || current.memo || "").trim(),
    });
  };
  (Array.isArray(source.suppliers) ? source.suppliers : []).forEach(addSupplier);
  parts.map((part) => part.supplier).forEach(addSupplier);
  parts.flatMap((part) => (part.purchases || []).map((purchase) => purchase.supplier)).forEach(addSupplier);
  return {
    partCategories: unique([
      ...savedCategories,
      ...parts.map((part) => part.category),
    ]),
    suppliers: [...supplierMap.values()],
  };
}

function normalizeProduct(product) {
  const recipe = Array.isArray(product.recipe) ? product.recipe : [];
  return {
    id: product.id || uid("product"),
    name: product.name || "名称未設定の商品",
    category: product.category || "",
    stock: Math.floor(toNumber(product.stock)),
    minStock: Math.floor(toNumber(product.minStock)),
    price: toNumber(product.price),
    unitCost: toNumber(product.unitCost),
    productions: Array.isArray(product.productions) ? product.productions.map(normalizeProductionRecord).filter((record) => record.quantity > 0) : [],
    image: product.image || "",
    barcode: product.barcode || "",
    recipe,
    memo: product.memo || "",
  };
}

function normalizeProductionRecord(record) {
  return {
    id: record.id || uid("production"),
    date: record.date || "",
    quantity: Math.floor(toNumber(record.quantity)),
    unitCost: toNumber(record.unitCost),
    totalCost: toNumber(record.totalCost),
    parts: Array.isArray(record.parts) ? record.parts : [],
  };
}

function normalizePart(part) {
  return {
    id: part.id || uid("part"),
    category: part.category || "",
    name: part.name || "名称未設定の部品",
    kind: part.kind || "other",
    stock: toNumber(part.stock),
    minStock: toNumber(part.minStock),
    unit: part.unit || "個",
    initialCost: toNumber(part.initialCost ?? part.cost),
    cost: toNumber(part.cost ?? part.initialCost),
    location: part.location || "",
    supplier: part.supplier || "",
    initialPurchaseDate: part.initialPurchaseDate || part.purchaseDate || "",
    purchaseDate: part.purchaseDate || "",
    purchases: Array.isArray(part.purchases) ? part.purchases.map(normalizePurchase).filter((purchase) => purchase.qty > 0) : [],
    image: part.image || "",
    barcode: part.barcode || "",
    memo: part.memo || "",
  };
}

function normalizePurchase(purchase) {
  const qty = toNumber(purchase.qty);
  const unitCost = toNumber(purchase.unitCost);
  return {
    id: purchase.id || uid("purchase"),
    date: purchase.date || "",
    supplier: purchase.supplier || "",
    qty,
    unitCost,
    total: toNumber(purchase.total) || qty * unitCost,
    memo: purchase.memo || "",
    batchId: purchase.batchId || "",
    batchSize: Math.max(1, Math.floor(toNumber(purchase.batchSize) || 1)),
  };
}

function normalizeVenue(venue) {
  const date = venue.date || "";
  const eventName = venue.eventName || venue.name || "名称未設定のイベント";
  const placeName = venue.placeName || venue.name || "";
  return {
    id: venue.id || uid("venue"),
    eventName,
    placeName,
    date,
    prefecture: venue.prefecture || "",
    applicationDeadline: venue.applicationDeadline || "",
    resultScheduledDate: venue.resultScheduledDate || "",
    actualOperationDate: venue.actualOperationDate || "",
    address: venue.address || "",
    boothFee: toNumber(venue.boothFee),
    parkingFee: toNumber(venue.parkingFee),
    transportFee: toNumber(venue.transportFee),
    otherFee: toNumber(venue.otherFee),
    plannedProductQty: Math.floor(toNumber(venue.plannedProductQty)),
    cashFloat: toNumber(venue.cashFloat),
    status: ["planned", "open", "closed"].includes(venue.status) ? venue.status : "planned",
    openedAt: venue.openedAt || "",
    closedAt: venue.closedAt || "",
    settlement: venue.settlement && typeof venue.settlement === "object" ? venue.settlement : null,
    prepItems: venue.prepItems || "",
    parkingLocation: venue.parkingLocation || "",
    transportTrips: Math.floor(toNumber(venue.transportTrips)),
    carriedProducts: Array.isArray(venue.carriedProducts) ? venue.carriedProducts.map((row) => ({
      productId: row.productId || "",
      quantity: Math.floor(toNumber(row.quantity)),
    })).filter((row) => row.productId || row.quantity > 0) : [],
    plannedProducts: Array.isArray(venue.plannedProducts) ? venue.plannedProducts.map((row) => ({
      productId: row.productId || "",
      quantity: Math.floor(toNumber(row.quantity)),
    })).filter((row) => row.productId || row.quantity > 0) : [],
    fixtures: venue.fixtures || "",
    review: venue.review || "",
    customNotes: venue.customNotes || "",
    prepChecklist: Array.isArray(venue.prepChecklist) ? venue.prepChecklist.map((item) => ({
      label: String(item.label || "").trim(),
      checked: Boolean(item.checked),
    })).filter((item) => item.label) : [],
    images: Array.isArray(venue.images) ? venue.images : [],
    memo: venue.memo || "",
  };
}

function normalizeCalendarEvent(event) {
  const startDate = event.startDate || event.date || "";
  const endDate = event.endDate || startDate;
  const type = ["application", "result", "event", "other"].includes(event.type) ? event.type : "other";
  return {
    id: event.id || uid("calendar"),
    type,
    title: String(event.title || "予定").trim(),
    startDate,
    endDate: endDate < startDate ? startDate : endDate,
    color: /^#[0-9a-f]{6}$/i.test(event.color || "") ? event.color : "#087694",
    memo: event.memo || "",
  };
}

function normalizeExpense(expense) {
  return {
    id: expense.id || uid("expense"),
    date: expense.date || "",
    category: expense.category || "その他",
    amount: Math.max(0, toNumber(expense.amount)),
    venueId: expense.venueId || "",
    venueLabel: expense.venueLabel || "",
    memo: expense.memo || "",
  };
}

function normalizeSale(sale = {}) {
  const quantity = Math.max(0, toNumber(sale.quantity));
  const unitPrice = Math.max(0, toNumber(sale.unitPrice));
  const unitCostAtSale = Math.max(0, toNumber(sale.unitCostAtSale));
  return {
    id: sale.id || uid("sale"),
    date: sale.date || "",
    venueId: sale.venueId || "",
    venueLabel: sale.venueLabel || "",
    itemType: sale.itemType === "part" ? "part" : "product",
    itemId: sale.itemId || "",
    itemName: sale.itemName || "名称未設定の品目",
    quantity,
    unitPrice,
    total: toNumber(sale.total) || quantity * unitPrice,
    unitCostAtSale,
    costAtSale: toNumber(sale.costAtSale) || unitCostAtSale * quantity,
    discountAmount: Math.max(0, toNumber(sale.discountAmount)),
    discountReason: sale.discountReason || "",
    editHistory: Array.isArray(sale.editHistory) ? sale.editHistory : [],
    refundHistory: Array.isArray(sale.refundHistory) ? sale.refundHistory : [],
    refundAmount: Math.max(0, toNumber(sale.refundAmount)),
    receivedAmount: toNumber(sale.receivedAmount),
    changeDue: toNumber(sale.changeDue),
    paymentMethod: sale.paymentMethod === "cashless" ? "cashless" : "cash",
    soldTime: sale.soldTime || sale.time || "",
    customerGender: ["female", "male", "other"].includes(sale.customerGender) ? sale.customerGender : "unknown",
    customerAgeGroup: ["under20", "20s", "30s", "40s", "50s", "60plus"].includes(sale.customerAgeGroup) ? sale.customerAgeGroup : "unknown",
    customerOrigin: ["domestic", "inbound"].includes(sale.customerOrigin) ? sale.customerOrigin : "unknown",
    customerRegion: ["western", "asian", "other"].includes(sale.customerRegion) ? sale.customerRegion : "unknown",
    memo: sale.memo || "",
    checkoutId: sale.checkoutId || "",
    status: sale.status === "cancelled" ? "cancelled" : "active",
    cancelledAt: sale.cancelledAt || "",
  };
}

// Local demo seed helper. Used once to populate a realistic maker dataset for UI review.
window.__seedMakerDemo = async function () {
  const amberSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect width="640" height="480" rx="36" fill="#fff0cf"/><circle cx="320" cy="230" r="150" fill="#fff" opacity=".5"/><path d="M320 95l33 78 84 7-64 54 20 82-73-44-73 44 20-82-64-54 84-7z" fill="#e9a24c" stroke="#8e4d32" stroke-width="8"/><circle cx="320" cy="66" r="25" fill="none" stroke="#8e4d32" stroke-width="9"/><path d="M320 88v22" stroke="#8e4d32" stroke-width="9"/><text x="320" y="425" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#633d2d">琥珀レジン・星キーホルダー</text></svg>`;
  const beadSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect width="640" height="480" rx="36" fill="#e7f7ff"/><circle cx="320" cy="225" r="142" fill="#fff" opacity=".5"/><g stroke="#5d5a83" stroke-width="5"><circle cx="320" cy="130" r="34" fill="#ffd2e1"/><circle cx="403" cy="180" r="34" fill="#bfe7ff"/><circle cx="390" cy="275" r="34" fill="#ffe69a"/><circle cx="250" cy="275" r="34" fill="#c9f2cc"/><circle cx="237" cy="180" r="34" fill="#d8c5ff"/><circle cx="320" cy="225" r="38" fill="#fff4bf"/></g><circle cx="320" cy="66" r="25" fill="none" stroke="#5d5a83" stroke-width="9"/><path d="M320 88v25" stroke="#5d5a83" stroke-width="9"/><text x="320" y="425" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#49476e">オーロラビーズ・花キーホルダー</text></svg>`;
  const eventSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><rect width="800" height="500" rx="40" fill="#dff5ed"/><path d="M0 340c160-80 280 50 430-20s250-35 370 15v165H0z" fill="#a9d9ca"/><path d="M210 315h380v95H210z" fill="#fffaf0" stroke="#547a6b" stroke-width="8"/><path d="M180 315l60-95h320l60 95z" fill="#f6b3a7" stroke="#547a6b" stroke-width="8"/><text x="400" y="290" text-anchor="middle" font-family="sans-serif" font-size="35" font-weight="700" fill="#547a6b">CRAFT MARKET</text><text x="400" y="465" text-anchor="middle" font-family="sans-serif" font-size="27" fill="#3e6154">青空クラフトマルシェ</text></svg>`;
  const img = (svg) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  const p = (id, name, kind, stock, minStock, unit, cost, location, supplier, memo, image = "") => normalizePart({ id, name, kind, stock, minStock, unit, cost, location, supplier, purchaseDate: "2026-10-19", image, memo, purchases: [{ id: `${id}-purchase`, date: "2026-10-19", supplier, qty: stock, unitCost: cost, total: stock * cost, memo: "初回仕入" }] });
  state.parts = [
    p("part-resin-clear", "UVレジン（クリア）", "liquid", 250, 80, "ml", 18, "材料棚A-1", "清水クラフト", "透明感のある作品用。硬化後は黄変しにくいタイプ。", img(amberSvg)),
    p("part-color-yellow", "着色剤（クリームイエロー）", "liquid", 30, 10, "ml", 120, "材料棚A-2", "清水クラフト", "琥珀色の調色用"),
    p("part-bead-aurora", "ガラスビーズ（オーロラ）", "solid", 120, 30, "個", 22, "ビーズケースB-1", "虹色パーツ店", "光の角度で色が変わるビーズ", img(beadSvg)),
    p("part-jump-ring", "丸カン 6mm", "solid", 100, 30, "個", 5, "金具ケースC-1", "金具問屋", "シルバー"),
    p("part-clasp", "キーホルダーパーツ（ナスカン）", "solid", 40, 10, "個", 35, "金具ケースC-2", "金具問屋", "シルバー"),
    p("part-glitter", "ラメフレーク（ゴールド）", "other", 20, 5, "g", 80, "材料棚A-3", "アトリエ資材店", "少量を封入"),
  ];
  state.products = [
    normalizeProduct({ id: "product-amber-star", name: "琥珀レジンの星キーホルダー", category: "レジン", stock: 8, minStock: 3, price: 1800, unitCost: 390, image: img(amberSvg), recipe: [{ partId: "part-resin-clear", qty: 8 }, { partId: "part-color-yellow", qty: .5 }, { partId: "part-jump-ring", qty: 1 }, { partId: "part-clasp", qty: 1 }, { partId: "part-glitter", qty: .2 }], memo: "星型・琥珀カラー" }),
    normalizeProduct({ id: "product-bead-flower", name: "オーロラビーズの花キーホルダー", category: "ビーズ", stock: 5, minStock: 2, price: 2200, unitCost: 560, image: img(beadSvg), recipe: [{ partId: "part-resin-clear", qty: 6 }, { partId: "part-bead-aurora", qty: 8 }, { partId: "part-jump-ring", qty: 1 }, { partId: "part-clasp", qty: 1 }], memo: "花モチーフ・オーロラ" }),
    normalizeProduct({ id: "product-clear-drop", name: "クリアしずくキーホルダー", category: "レジン", stock: 0, minStock: 2, price: 1500, unitCost: 250, recipe: [{ partId: "part-resin-clear", qty: 5 }, { partId: "part-jump-ring", qty: 1 }, { partId: "part-clasp", qty: 1 }], memo: "次回製作予定" }),
  ];
  state.venues = [
    normalizeVenue({ id: "venue-aozora", eventName: "青空クラフトマルシェ", placeName: "海辺公園・ブースB12", prefecture: "東京都", date: "2026-11-08", address: "東京都江東区海辺公園1-2", boothFee: 3000, parkingFee: 1000, transportFee: 800, otherFee: 500, plannedProductQty: 20, cashFloat: 10000, status: "open", openedAt: "2026-11-08T09:00:00+09:00", images: [img(eventSvg)], prepItems: "テーブル、什器、値札、袋、釣り銭、ショップカード", memo: "秋色アクセサリー特集" }),
    normalizeVenue({ id: "venue-winter", eventName: "ハンドメイド冬支度", placeName: "駅前広場・ブースD04", prefecture: "東京都", date: "2026-12-06", address: "東京都台東区駅前広場", boothFee: 2500, parkingFee: 0, transportFee: 600, otherFee: 300, plannedProductQty: 15, cashFloat: 8000, status: "planned", images: [], prepItems: "冬色ディスプレイ、ギフト袋、ショップカード", memo: "クリスマス向け" }),
  ];
  state.sales = [
    normalizeSale({ id: "sale-demo-1", date: "2026-10-19", venueId: "venue-aozora", venueLabel: "青空クラフトマルシェ", itemType: "product", itemId: "product-amber-star", itemName: "琥珀レジンの星キーホルダー", quantity: 2, unitPrice: 1800, total: 3600, unitCostAtSale: 390, costAtSale: 780, receivedAmount: 4000, changeDue: 400, paymentMethod: "cash", memo: "サンプル販売" }),
    normalizeSale({ id: "sale-demo-2", date: "2026-10-19", venueId: "venue-aozora", venueLabel: "青空クラフトマルシェ", itemType: "product", itemId: "product-bead-flower", itemName: "オーロラビーズの花キーホルダー", quantity: 1, unitPrice: 2200, total: 2200, unitCostAtSale: 560, costAtSale: 560, paymentMethod: "cashless", memo: "サンプル販売" }),
  ];
  state.expenses = [
    normalizeExpense({ id: "expense-demo-1", date: "2026-11-08", category: "出展料", amount: 3000, venueId: "venue-aozora", venueLabel: "青空クラフトマルシェ", memo: "ブース代" }),
    normalizeExpense({ id: "expense-demo-2", date: "2026-11-08", category: "交通費", amount: 800, venueId: "venue-aozora", venueLabel: "青空クラフトマルシェ", memo: "往復交通費" }),
  ];
  state.stockAdjustments = [];
  state.operationLogs = [];
  state.masters = normalizeMasters(state.masters, state.parts);
  saveState({ action: "サンプルデータ登録" });
  renderAll();
  showToast("サンプルデータを登録しました");
};

function saleIsActive(sale) {
  return sale.status !== "cancelled";
}

function saveState({ createBackup = true, recordUndo = true, action = "データ更新" } = {}) {
  if (recordUndo && lastPersistedSnapshot !== JSON.stringify(state)) {
    undoStack.push(lastPersistedSnapshot);
    if (undoStack.length > 20) undoStack.shift();
  }
  state.operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
  state.operationLogs.unshift({
    id: uid("log"),
    at: new Date().toISOString(),
    userId: "owner",
    action,
  });
  state.operationLogs = state.operationLogs.slice(0, 200);
  if (storageBackend === "indexeddb") {
    const backupSaved = createBackup ? writeAutoBackup() : true;
    scheduleDatabaseWrite();
    lastBackupSaved = backupSaved;
    lastPersistedSnapshot = JSON.stringify(state);
    updateStorageStatus(true, null, backupSaved);
    return true;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("データを保存できませんでした", error);
    restoreLastPersistedState();
    showToast("保存容量を超えたため、データを保存できませんでした。画像を減らしてください。");
    updateStorageStatus(false, error);
    lastBackupSaved = false;
    return false;
  }
  const backupSaved = createBackup ? writeAutoBackup() : true;
  lastBackupSaved = backupSaved;
  lastPersistedSnapshot = JSON.stringify(state);
  updateStorageStatus(true, null, backupSaved);
  return true;
}

// ---- 保存先（IndexedDB。使えない環境では localStorage） ----
const DB_NAME = "marche-stock";
const DB_VERSION = 1;
const MAX_BACKUPS = 10;
const IMAGE_MIN_LENGTH = 1024;
let storageBackend = "indexeddb";
let databasePromise = null;
let backupsCache = [];
let knownImageIds = new Set();
const pendingImages = new Map();
let databaseWriteChain = Promise.resolve();
let databaseWriteQueued = false;
let databaseWritesPending = 0;

async function initStorage() {
  try {
    databasePromise = openDatabase();
    const db = await databasePromise;
    const tx = db.transaction(["kv", "images"], "readonly");
    const [storedState, storedBackups, imageIds] = await Promise.all([
      requestResult(tx.objectStore("kv").get("state")),
      requestResult(tx.objectStore("kv").get("backups")),
      requestResult(tx.objectStore("images").getAllKeys()),
    ]);
    knownImageIds = new Set(imageIds);
    if (storedState) {
      const ids = new Set();
      collectImageRefs(storedState, ids);
      replaceState(loadState(injectImages(storedState, await loadImages(ids))));
      backupsCache = validBackups(storedBackups);
    } else {
      await migrateFromLocalStorage();
    }
  } catch (error) {
    console.warn("IndexedDB を使えないため localStorage に保存します", error);
    storageBackend = "localStorage";
    const legacy = readLocalStorageData();
    replaceState(loadState(legacy.raw));
    backupsCache = legacy.backups;
  }
  lastPersistedSnapshot = JSON.stringify(state);
}

// 初回だけ、これまでの localStorage のデータを IndexedDB へ移す。元のデータは念のため消さずに残す。
async function migrateFromLocalStorage() {
  const legacy = readLocalStorageData();
  replaceState(loadState(legacy.raw));
  if (!legacy.raw || stateLoadError) return;
  backupsCache = legacy.backups.map((backup) => ({ ...backup, data: extractImages(backup.data, pendingImages) }));
  await writeToDatabase();
  const db = await databasePromise;
  const tx = db.transaction("kv", "readwrite");
  tx.objectStore("kv").put(new Date().toISOString(), "migratedFromLocalStorageAt");
  await transactionDone(tx);
}

function readLocalStorageData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY) || "";
    let backups = [];
    try {
      backups = validBackups(JSON.parse(localStorage.getItem(BACKUP_KEY) || "[]"));
    } catch {
      backups = [];
    }
    return { raw, backups };
  } catch (error) {
    stateLoadError = error;
    return { raw: "", backups: [] };
  }
}

function replaceState(next) {
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, next);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

// 連続した保存は1回の書き込みにまとめ、順番どおりに書き込む。
function scheduleDatabaseWrite() {
  if (databaseWriteQueued) return;
  databaseWriteQueued = true;
  databaseWritesPending += 1;
  databaseWriteChain = databaseWriteChain
    .then(() => {
      databaseWriteQueued = false;
      return writeToDatabase();
    })
    .catch((error) => {
      console.error("データを保存できませんでした", error);
      lastBackupSaved = false;
      updateStorageStatus(false, error);
      showToast("データを保存できませんでした。端末の空き容量を確認してください。");
    })
    .finally(() => { databaseWritesPending -= 1; });
}

async function writeToDatabase() {
  const images = new Map(pendingImages);
  pendingImages.clear();
  try {
    const stateRecord = extractImages(state, images);
    const referenced = new Set();
    collectImageRefs(stateRecord, referenced);
    backupsCache.forEach((backup) => collectImageRefs(backup.data, referenced));
    const db = await databasePromise;
    const tx = db.transaction(["kv", "images"], "readwrite");
    const imageStore = tx.objectStore("images");
    const stored = new Set();
    referenced.forEach((id) => {
      if (knownImageIds.has(id)) stored.add(id);
      else if (images.has(id)) {
        imageStore.put(images.get(id), id);
        stored.add(id);
      }
    });
    // どこからも参照されなくなった画像を削除する。
    knownImageIds.forEach((id) => { if (!referenced.has(id)) imageStore.delete(id); });
    tx.objectStore("kv").put(stateRecord, "state");
    tx.objectStore("kv").put(backupsCache, "backups");
    await transactionDone(tx);
    knownImageIds = stored;
  } catch (error) {
    images.forEach((value, id) => { if (!pendingImages.has(id)) pendingImages.set(id, value); });
    throw error;
  }
}

async function loadImages(ids) {
  const images = new Map();
  if (!ids.size) return images;
  const db = await databasePromise;
  const store = db.transaction("images", "readonly").objectStore("images");
  await Promise.all([...ids].map(async (id) => {
    const value = await requestResult(store.get(id));
    if (typeof value === "string") images.set(id, value);
  }));
  return images;
}

function imageId(value) {
  // cyrb53: 画像文字列から重複判定用のIDを作る（暗号用途ではない）。
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `img_${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}_${value.length.toString(36)}`;
}

// data:image/... の文字列を { __imageRef: id } に置き換えたコピーを返し、画像本体を images に集める。
function extractImages(value, images) {
  if (typeof value === "string") {
    if (value.length < IMAGE_MIN_LENGTH || !value.startsWith("data:image/")) return value;
    const id = imageId(value);
    images.set(id, value);
    return { __imageRef: id };
  }
  if (Array.isArray(value)) return value.map((item) => extractImages(item, images));
  if (value && typeof value === "object") {
    if (typeof value.__imageRef === "string") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, extractImages(item, images)]));
  }
  return value;
}

function collectImageRefs(value, ids) {
  if (Array.isArray(value)) value.forEach((item) => collectImageRefs(item, ids));
  else if (value && typeof value === "object") {
    if (typeof value.__imageRef === "string") ids.add(value.__imageRef);
    else Object.values(value).forEach((item) => collectImageRefs(item, ids));
  }
}

function injectImages(value, images) {
  if (Array.isArray(value)) return value.map((item) => injectImages(item, images));
  if (value && typeof value === "object") {
    if (typeof value.__imageRef === "string") return images.get(value.__imageRef) || "";
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, injectImages(item, images)]));
  }
  return value;
}

function restoreLastPersistedState() {
  try {
    const restored = normalizeImportedState(JSON.parse(lastPersistedSnapshot));
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, restored);
  } catch (error) {
    console.error("保存前の状態へ戻せませんでした", error);
  }
}

function updateStorageStatus(saved, error = null, backupSaved = lastBackupSaved) {
  const node = document.getElementById("storageStatus");
  if (!node) return;
  const size = storageUsageBytes();
  node.textContent = saved
    ? `${backupSaved ? "保存済み" : "本体保存済み・バックアップ失敗"} / データ ${formatBytes(size)}`
    : `保存失敗 / ${error?.name || "容量を確認してください"}`;
  node.classList.toggle("error", !saved || !backupSaved);
  node.classList.toggle("success", saved && backupSaved);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function storageUsageBytes() {
  const stateSize = new Blob([JSON.stringify(state)]).size;
  const backupSize = new Blob([JSON.stringify(backupsCache)]).size;
  return stateSize + backupSize;
}

function undoLastChange() {
  const snapshot = undoStack.pop();
  if (!snapshot) {
    showToast("取り消せる操作がありません");
    return;
  }
  try {
    Object.assign(state, normalizeImportedState(JSON.parse(snapshot)));
    if (!saveState({ recordUndo: false, action: "直前操作を取り消し" })) return;
    renderAll();
    showToast("直前の操作を取り消しました");
  } catch (error) {
    console.error(error);
    showToast("操作を取り消せませんでした");
  }
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function setTodayDefaults() {
  const today = new Date().toISOString().slice(0, 10);
  const saleDate = document.querySelector("#saleForm [name=date]");
  const venueDate = document.querySelector("#venueForm [name=date]");
  const expenseDate = document.querySelector("#expenseForm [name=date]");
  const partPurchaseDate = document.querySelector("#partForm [name=purchaseDate]");
  const addPurchaseDate = document.querySelector("#partForm [name=purchaseDateNew]");
  const purchaseDate = document.querySelector("#purchaseForm [name=date]");
  if (saleDate && !saleDate.value) saleDate.value = today;
  if (venueDate && !venueDate.value) venueDate.value = today;
  if (expenseDate && !expenseDate.value) expenseDate.value = today;
  if (partPurchaseDate && !partPurchaseDate.value) partPurchaseDate.value = today;
  if (addPurchaseDate && !addPurchaseDate.value) addPurchaseDate.value = today;
  if (purchaseDate && !purchaseDate.value) purchaseDate.value = today;
}

function currentTimeValue() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function setRegisterDefaultTime() {
  const input = document.querySelector("#registerSaleForm [name=soldTime]");
  if (input && !input.value) input.value = currentTimeValue();
}

function syncCustomerRegionFields(form) {
  if (!form) return;
  const origin = form.elements.customerOrigin?.value || "unknown";
  const field = form.querySelector("[data-customer-region-field]");
  if (!field) return;
  const visible = origin === "inbound";
  field.hidden = !visible;
  const region = form.elements.customerRegion;
  if (region) {
    region.disabled = !visible;
    if (!visible) region.value = "unknown";
  }
}

// iPad・スマホでは、サイドバーをメニューボタンから重ねて開く。
const compactNavQuery = window.matchMedia("(max-width: 1080px)");

function setNavOpen(open) {
  const toggle = document.getElementById("menuToggle");
  const backdrop = document.getElementById("navBackdrop");
  const sidebar = document.getElementById("appSidebar");
  const active = open && compactNavQuery.matches;
  document.body.classList.toggle("nav-open", active);
  if (backdrop) backdrop.hidden = !active;
  toggle?.setAttribute("aria-expanded", String(active));
  toggle?.setAttribute("aria-label", active ? "メニューを閉じる" : "メニューを開く");
  sidebar?.toggleAttribute("inert", compactNavQuery.matches && !active);
  if (active) sidebar?.querySelector(".nav-item.active, .nav-item")?.focus();
}

function bindCompactNavigation() {
  const toggle = document.getElementById("menuToggle");
  toggle?.addEventListener("click", () => setNavOpen(!document.body.classList.contains("nav-open")));
  document.getElementById("navBackdrop")?.addEventListener("click", () => setNavOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("nav-open")) {
      setNavOpen(false);
      toggle?.focus();
    }
  });
  compactNavQuery.addEventListener("change", () => setNavOpen(false));
  setNavOpen(false);
}

function bindNavigation() {
  bindCompactNavigation();
  document.querySelector(".nav-item.active")?.setAttribute("aria-current", "page");
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", async () => {
      const dirtyForm = [...document.querySelectorAll("form[data-dirty=\"1\"]")].find((form) => !form.closest(".view:not(.active)"));
      if (dirtyForm) {
        const ok = await showConfirm("入力内容を破棄しますか？", "保存されていない入力内容があります。画面を移動すると破棄されます。");
        if (!ok) return;
        dirtyForm.dataset.dirty = "0";
      }
      document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".nav-item").forEach((item) => item.removeAttribute("aria-current"));
      document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
      button.classList.add("active");
      button.setAttribute("aria-current", "page");
      document.getElementById(button.dataset.view).classList.add("active");
      document.getElementById("view-title").textContent = views[button.dataset.view];
      setNavOpen(false);
    });
  });
}

function bindManagementTabs() {
  const tabs = document.querySelectorAll("[data-management-tab]");
  const panels = document.querySelectorAll("[data-management-panel]");
  if (!tabs.length || !panels.length) return;
  tabs.forEach((tab) => tab.addEventListener("click", () => {
    const target = tab.dataset.managementTab;
    tabs.forEach((item) => {
      const active = item === tab;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.managementPanel !== target; });
  }));
  panels.forEach((panel) => { panel.hidden = panel.dataset.managementPanel !== "stock"; });
}

function ensureSaleDiscountField() {
  const form = document.getElementById("saleForm");
  if (!form || form.elements.discountAmount) return;
  const paymentLabel = form.elements.paymentMethod?.closest("label");
  if (!paymentLabel) return;
  const label = document.createElement("label");
  label.className = "sale-discount-field";
  label.innerHTML = `割引額（円）<input name="discountAmount" type="number" min="0" step="1" value="0" />`;
  paymentLabel.before(label);
  const reason = document.createElement("label");
  reason.className = "sale-discount-field";
  reason.innerHTML = `割引理由（任意）<input name="discountReason" type="text" maxlength="80" placeholder="セット割、常連割など" />`;
  paymentLabel.before(reason);
}

function bindForms() {
  ensureSaleDiscountField();
  document.querySelectorAll("form").forEach((form) => {
    form.addEventListener("input", () => { form.dataset.dirty = "1"; });
    form.addEventListener("change", () => { form.dataset.dirty = "1"; });
    form.addEventListener("reset", () => { form.dataset.dirty = "0"; });
    form.addEventListener("invalid", (event) => {
      event.target.classList.add("input-error");
      event.target.setAttribute("aria-invalid", "true");
    }, true);
    form.addEventListener("input", (event) => {
      if (event.target.checkValidity?.()) {
        event.target.classList.remove("input-error");
        event.target.removeAttribute("aria-invalid");
      }
    });
  });
  document.getElementById("partForm").addEventListener("submit", savePart);
  bindPartMasterControls();
  ["stock", "initialCost", "purchaseQty", "purchaseCost"].forEach((name) => {
    document.querySelector(`#partForm [name="${name}"]`)?.addEventListener("input", renderPartAverageCost);
  });
  document.getElementById("partSupplier")?.addEventListener("change", (event) => {
    const purchaseSupplier = document.querySelector("#partForm [name=purchaseSupplier]");
    if (purchaseSupplier && !purchaseSupplier.value) purchaseSupplier.value = event.target.value;
  });
  document.querySelectorAll("[data-master-form]").forEach((form) => form.addEventListener("submit", saveMasterForm));
  document.getElementById("masterEntryForm")?.addEventListener("submit", saveMasterFromModal);
  document.getElementById("closeMasterEntryModal")?.addEventListener("click", closeMasterEntryModal);
  document.getElementById("cancelMasterEntryModal")?.addEventListener("click", closeMasterEntryModal);
  document.getElementById("masterEntryBackdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "masterEntryBackdrop") closeMasterEntryModal();
  });
  document.getElementById("productForm").addEventListener("submit", saveProduct);
  document.getElementById("productionForm").addEventListener("submit", saveProduction);
  document.getElementById("venueForm").addEventListener("submit", saveVenue);
  document.getElementById("purchaseForm").addEventListener("submit", savePurchase);
  document.getElementById("addPurchaseLine")?.addEventListener("click", () => addPurchaseLine());
  document.getElementById("purchaseLines")?.addEventListener("click", (event) => {
    const modeButton = event.target.closest("[data-purchase-mode]");
    if (modeButton) {
      setPurchaseLineMode(modeButton.closest("[data-purchase-line]"), modeButton.dataset.purchaseMode);
      return;
    }
    const quantityButton = event.target.closest("[data-purchase-qty-step]");
    if (quantityButton) {
      const line = quantityButton.closest("[data-purchase-line]");
      const input = line?.querySelector("[name=batchQty]");
      if (input) input.value = Math.max(0.01, toNumber(input.value) + toNumber(quantityButton.dataset.purchaseQtyStep));
      return;
    }
    if (!event.target.closest("[data-remove-purchase-line]")) return;
    const lines = document.querySelectorAll("[data-purchase-line]");
    if (lines.length <= 1) {
      showToast("部品は1行以上必要です");
      return;
    }
    event.target.closest("[data-purchase-line]")?.remove();
  });
  bindImagePreview("#partForm [name=image]", "partImagePreview");
  bindImagePreview("#productForm [name=image]", "productImagePreview");
  bindImagePreview("#venueForm [name=images]", "venueImagePreview", true);
  document.getElementById("saleForm").addEventListener("submit", saveSale);
  document.getElementById("expenseForm").addEventListener("submit", saveExpense);
  document.getElementById("stockAdjustmentForm").addEventListener("submit", saveStockAdjustment);
  document.getElementById("adjustmentItemType").addEventListener("change", renderAdjustmentOptions);
  document.getElementById("barcodeSearch").addEventListener("input", renderBarcodeSearch);
  document.getElementById("generateQrBtn").addEventListener("click", generateQrCode);
  document.getElementById("userForm")?.addEventListener("submit", saveUser);
  document.getElementById("activeUser")?.addEventListener("change", renderManagement);
  const dashboardSaleForm = document.getElementById("dashboardSaleForm");
  if (dashboardSaleForm) dashboardSaleForm.addEventListener("submit", saveDashboardSale);
  document.getElementById("registerSaleForm").addEventListener("submit", saveRegisterSale);
  document.getElementById("registerEvent").addEventListener("change", renderRegisterTotals);
  document.getElementById("openRegisterPicker")?.addEventListener("click", openRegisterPicker);
  document.getElementById("closePicker")?.addEventListener("click", closeRegisterPicker);
  document.getElementById("registerQuantity").addEventListener("input", renderRegisterTotals);
  document.getElementById("registerUnitPrice").addEventListener("input", renderRegisterTotals);
  document.getElementById("registerReceived").addEventListener("input", renderRegisterTotals);
  document.getElementById("registerDiscount").addEventListener("input", renderRegisterTotals);
  document.querySelectorAll("[data-discount-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById("registerDiscount");
      input.value = toNumber(input.value) + toNumber(button.dataset.discountStep);
      renderRegisterTotals();
    });
  });
  document.getElementById("registerPaymentMethod").addEventListener("change", renderRegisterTotals);
  document.querySelectorAll("[data-register-payment]").forEach((button) => {
    button.addEventListener("click", () => setRegisterPaymentMethod(button.dataset.registerPayment));
  });
  document.querySelectorAll("#registerSaleForm [name=customerOrigin], #saleForm [name=customerOrigin]").forEach((select) => {
    select.addEventListener("change", () => syncCustomerRegionFields(select.form));
    syncCustomerRegionFields(select.form);
  });
  document.getElementById("eventWorkflowEvent")?.addEventListener("change", renderEventWorkflow);
  document.getElementById("eventSettlementForm")?.addEventListener("submit", saveEventSettlement);
  document.getElementById("addRegisterLine")?.addEventListener("click", addRegisterLine);
  document.getElementById("clearRegisterCart").addEventListener("click", clearRegisterCart);
  document.querySelectorAll("[data-register-type]").forEach((button) => {
    button.addEventListener("click", () => setRegisterType(button.dataset.registerType));
  });
  document.querySelectorAll("[data-qty-step]").forEach((button) => {
    button.addEventListener("click", () => changeRegisterQuantity(toNumber(button.dataset.qtyStep)));
  });
  document.getElementById("registerKeypad").addEventListener("click", handleRegisterKeypad);
  document.querySelectorAll("[data-register-screen-target]").forEach((button) => {
    button.addEventListener("click", () => setRegisterScreen(button.dataset.registerScreenTarget));
  });
  document.querySelectorAll("[data-register-next]").forEach((button) => {
    button.addEventListener("click", () => setRegisterScreen(button.dataset.registerNext));
  });
  document.querySelectorAll("[data-register-back]").forEach((button) => {
    button.addEventListener("click", () => setRegisterScreen(button.dataset.registerBack));
  });
  document.querySelectorAll("[data-register-finish]").forEach((button) => {
    button.addEventListener("click", finishRegisterCheckout);
  });
  document.querySelector("[data-save-register-attributes]")?.addEventListener("click", saveRegisterAttributes);
  document.getElementById("dashboardEventSelect")?.addEventListener("change", renderDashboardEventSummary);
  document.getElementById("dashboardPeriod")?.addEventListener("change", () => {
    renderDashboardCharts();
    const period = document.getElementById("dashboardPeriod");
    period?.setAttribute("aria-label", `グラフ期間：${period.options[period.selectedIndex]?.text || ""}`);
  });
  document.getElementById("eventSalesPeriod")?.addEventListener("change", () => {
    renderEventSalesChart();
  });
  document.getElementById("addRecipeRow").addEventListener("click", () => addRecipeRow());
  document.getElementById("productionProduct").addEventListener("change", renderProductionPreview);
  document.querySelector("#productionForm [name=quantity]").addEventListener("input", renderProductionPreview);
  document.getElementById("saleItemType").addEventListener("change", renderSaleOptions);
  document.getElementById("saleItem").addEventListener("change", fillSalePrice);
  document.querySelector("#saleForm [name=quantity]").addEventListener("input", renderSalePos);
  document.querySelector("#saleForm [name=unitPrice]").addEventListener("input", renderSalePos);
  document.querySelector("#saleForm [name=discountAmount]")?.addEventListener("input", renderSalePos);
  document.querySelector("#saleForm [name=receivedAmount]").addEventListener("input", renderSalePos);
  bindIfExists("dashboardSaleItemType", "change", renderDashboardSaleOptions);
  bindIfExists("dashboardSaleItem", "change", fillDashboardSalePrice);
  document.querySelector("#dashboardSaleForm [name=quantity]")?.addEventListener("input", renderDashboardPos);
  document.querySelector("#dashboardSaleForm [name=unitPrice]")?.addEventListener("input", renderDashboardPos);
  document.querySelector("#dashboardSaleForm [name=receivedAmount]")?.addEventListener("input", renderDashboardPos);
  document.getElementById("partSearch").addEventListener("input", renderParts);
  document.getElementById("partSort").addEventListener("change", renderParts);
  document.getElementById("productSearch").addEventListener("input", renderProducts);
  document.getElementById("productSort").addEventListener("change", renderProducts);
  document.getElementById("purchaseSearch").addEventListener("input", renderPurchases);
  document.getElementById("purchaseSort").addEventListener("change", renderPurchases);
  document.getElementById("venueSort").addEventListener("change", renderVenues);
  document.getElementById("stockHistoryType").addEventListener("change", renderStockHistory);
  document.getElementById("stockHistorySearch").addEventListener("input", renderStockHistory);
  ["saleFilterVenue", "saleFilterType", "saleFilterFrom", "saleFilterTo", "saleFilterKeyword"].forEach((id) => {
    bindIfExists(id, "input", renderSales);
    bindIfExists(id, "change", renderSales);
  });
  ["analysisPeriod", "analysisVenue", "analysisTrendMode"].forEach((id) => {
    bindIfExists(id, "input", renderSalesAnalysis);
    bindIfExists(id, "change", renderSalesAnalysis);
  });

  document.getElementById("partForm").addEventListener("reset", () => setTimeout(() => clearPartForm(false)));
  document.getElementById("productForm").addEventListener("reset", () => setTimeout(() => clearProductForm(false)));
  document.getElementById("newPartBtn")?.addEventListener("click", () => { clearPartForm(); openPartEditor(); });
  document.getElementById("newProductBtn")?.addEventListener("click", () => { clearProductForm(); openProductEditor(); });
  document.querySelectorAll(".catalog-form-drawer").forEach((drawer) => {
    const header = drawer.querySelector(".panel-header");
    if (header && !header.querySelector(".drawer-close")) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "icon-button drawer-close";
      close.setAttribute("aria-label", "閉じる");
      close.textContent = "×";
      header.appendChild(close);
    }
  });
  document.getElementById("partEditorDrawer")?.addEventListener("click", handleCatalogDrawerClick);
  document.getElementById("productEditorDrawer")?.addEventListener("click", handleCatalogDrawerClick);
  document.getElementById("productionDrawer")?.addEventListener("click", handleCatalogDrawerClick);
  document.getElementById("venueForm").addEventListener("reset", () => setTimeout(() => clearVenueForm(false)));
  document.getElementById("newVenueBtn")?.addEventListener("click", () => {
    setVenuePageTab("record");
    clearVenueForm();
    openVenueEditor();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  document.getElementById("venueEditorDrawer")?.addEventListener("click", (event) => {
    if (event.target.closest(".drawer-close")) closeVenueEditor();
  });
  document.getElementById("addVenueCarryRow")?.addEventListener("click", () => addVenueCarryRow());
  document.getElementById("addVenuePlanRow")?.addEventListener("click", () => addVenuePlanRow());
  addVenueDrawerCloseButton();
  document.getElementById("purchaseForm").addEventListener("reset", () => setTimeout(() => clearPurchaseForm(false)));
  document.getElementById("saleForm").addEventListener("reset", () => setTimeout(() => clearSaleForm(false)));
  window.addEventListener("beforeunload", (event) => {
    if (!document.querySelector("form[data-dirty=\"1\"]") && !databaseWritesPending) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

// iPad などブラウザで使うときのオフライン対応。Electron（file://）では使わない。
function registerOfflineSupport() {
  if (!location.protocol.startsWith("http") || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch((error) => console.warn("Service Worker を登録できませんでした", error));
  // ブラウザの容量整理で保存データが消されにくくする。
  navigator.storage?.persist?.().catch(() => {});
}

function bindIfExists(id, eventName, handler) {
  const element = document.getElementById(id);
  if (element) element.addEventListener(eventName, handler);
}

function bindSectionTabs() {
  document.querySelectorAll("[data-section-tabs]").forEach((tabBar) => {
    const group = tabBar.dataset.sectionTabs;
    tabBar.querySelectorAll("[data-section-tab]").forEach((button) => {
      button.addEventListener("click", () => setSectionTab(group, button.dataset.sectionTab));
    });
    setSectionTab(group, "list");
  });
}

function setSectionTab(group, target) {
  const tabBar = document.querySelector(`[data-section-tabs="${group}"]`);
  if (!tabBar) return;
  tabBar.querySelectorAll("[data-section-tab]").forEach((button) => {
    const active = button.dataset.sectionTab === target;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(`[data-section-panel-group="${group}"]`).forEach((panel) => {
    panel.hidden = panel.dataset.sectionPanel !== target;
  });
}

function bindPartMasterControls() {
  document.querySelectorAll("[data-master-toggle]").forEach((button) => {
    button.addEventListener("click", () => openMasterEntryModal(button.dataset.masterToggle));
  });
}

function openMasterEntryModal(key, initialValue = "") {
  const backdrop = document.getElementById("masterEntryBackdrop");
  const form = document.getElementById("masterEntryForm");
  if (!backdrop || !form) return;
  form.reset();
  form.elements.key.value = key;
  form.elements.value.value = initialValue;
  const supplierFields = document.getElementById("supplierMasterDetailFields");
  const supplier = key === "suppliers";
  supplierFields.hidden = !supplier;
  document.getElementById("masterEntryTitle").textContent = supplier ? "仕入先マスタを追加" : "部品カテゴリマスタを追加";
  backdrop.classList.add("show");
  backdrop.setAttribute("aria-hidden", "false");
  setTimeout(() => form.elements.value.focus(), 80);
}

function closeMasterEntryModal() {
  const backdrop = document.getElementById("masterEntryBackdrop");
  if (!backdrop) return;
  backdrop.classList.remove("show");
  backdrop.setAttribute("aria-hidden", "true");
}

function saveMasterFromModal(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const key = form.elements.key.value;
  const value = form.elements.value.value.trim();
  if (!key || !value) return;
  const entry = key === "suppliers"
    ? { id: uid("supplier"), name: value, address: form.elements.address.value.trim(), memo: form.elements.memo.value.trim() }
    : value;
  state.masters = normalizeMasters({
    ...state.masters,
    [key]: [...(state.masters?.[key] || []), entry],
  }, state.parts);
  if (!saveState({ action: "マスタを追加" })) return;
  closeMasterEntryModal();
  renderMasterLists();
  renderPartMasterOptions();
  if (key === "partCategories") document.getElementById("partCategory").value = value;
  if (key === "suppliers") document.getElementById("partSupplier").value = value;
  showToast(`${value}をマスタに登録しました`);
}

function renderPartMasterOptions() {
  const form = document.getElementById("partForm");
  if (!form || !state.masters) return;
  const categorySelect = document.getElementById("partCategory");
  const currentCategory = form.elements.category?.value || "";
  if (categorySelect) {
    const categories = [...state.masters.partCategories];
    if (currentCategory && !categories.includes(currentCategory)) categories.unshift(currentCategory);
    categorySelect.innerHTML = `<option value="">カテゴリを選択</option>${categories.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
    categorySelect.value = currentCategory;
  }
  ["partSupplier", "partPurchaseSupplier"].forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    const currentValue = select.value || "";
    const suppliers = [...state.masters.suppliers];
    if (currentValue && !suppliers.some((supplier) => supplier.name === currentValue)) suppliers.unshift({ name: currentValue });
    select.innerHTML = `<option value="">仕入先を選択</option>${suppliers.map((supplier) => `<option value="${escapeHtml(supplier.name)}">${escapeHtml(supplier.name)}</option>`).join("")}`;
    select.value = currentValue;
  });
}

function renderPartAverageCost() {
  const form = document.getElementById("partForm");
  const output = document.getElementById("partAverageCost");
  if (!form || !output) return;
  const existing = state.parts.find((part) => part.id === form.elements.id.value);
  const stock = toNumber(form.elements.stock.value);
  const initialCost = toNumber(form.elements.initialCost.value);
  const additionalQty = toNumber(form.elements.purchaseQty.value);
  const additionalCost = toNumber(form.elements.purchaseCost.value);
  const baseCost = existing ? toNumber(existing.cost) : initialCost;
  const totalStock = stock + additionalQty;
  const totalValue = stock * baseCost + additionalQty * additionalCost;
  const average = totalStock > 0 ? Math.round(totalValue / totalStock) : 0;
  output.value = average > 0 ? yen.format(average) : "未計算";
}

function bindUtilityActions() {
  const tutorialHelpBtn = document.createElement("button");
  tutorialHelpBtn.className = "ghost-button";
  tutorialHelpBtn.id = "tutorialHelpBtn";
  tutorialHelpBtn.type = "button";
  tutorialHelpBtn.textContent = "操作ガイド";
  tutorialHelpBtn.addEventListener("click", startTutorial);
  document.querySelector(".topbar-actions")?.prepend(tutorialHelpBtn);
  const resetButton = document.getElementById("resetBtn");
  if (resetButton) {
    resetButton.textContent = "全データ初期化";
    resetButton.title = "保存済みの在庫・売上・画像をすべて削除します";
  }
  document.getElementById("exportBtn")?.addEventListener("click", exportJson);
  document.getElementById("restoreBackupBtn")?.addEventListener("click", restoreLatestBackup);
  document.getElementById("importInput")?.addEventListener("change", importJson);
  document.getElementById("undoBtn").addEventListener("click", undoLastChange);
  document.getElementById("refreshBackupsBtn")?.addEventListener("click", renderManagement);
  document.getElementById("exportSalesCsvBtn").addEventListener("click", () => exportCsv("sales"));
  document.getElementById("exportPartsCsvBtn").addEventListener("click", () => exportCsv("parts"));
  document.getElementById("exportProductsCsvBtn").addEventListener("click", () => exportCsv("products"));
  document.getElementById("printLastReceiptBtn").addEventListener("click", printLastReceipt);
  document.getElementById("dataExportBtn")?.addEventListener("click", exportJson);
  document.getElementById("dataImportInput")?.addEventListener("change", importJson);
  document.getElementById("dataRestoreBackupBtn")?.addEventListener("click", restoreLatestBackup);
  document.getElementById("dataRefreshBackupsBtn")?.addEventListener("click", renderDataManagement);
  document.getElementById("runIntegrityCheckBtn")?.addEventListener("click", renderIntegrityCheck);
  document.getElementById("dataStartTutorialBtn")?.addEventListener("click", startTutorial);
  document.getElementById("startTutorialBtn")?.addEventListener("click", startTutorial);
  document.getElementById("tutorialSkipBtn")?.addEventListener("click", finishTutorial);
  document.getElementById("tutorialBackBtn")?.addEventListener("click", () => moveTutorial(-1));
  document.getElementById("tutorialNextBtn")?.addEventListener("click", () => moveTutorial(1));
  document.querySelectorAll("[data-jump-view]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector(`.nav-item[data-view="${button.dataset.jumpView}"]`)?.click();
    });
  });
  document.getElementById("resetBtn")?.addEventListener("click", async () => {
    const ok = await showConfirm("初期化しますか？", "保存済みデータをすべて削除します。この操作は元に戻せません。");
    if (!ok) return;
    writeAutoBackup();
    Object.assign(state, { parts: [], products: [], venues: [], sales: [], expenses: [], stockAdjustments: [], operationLogs: [] });
    if (!saveState({ createBackup: false })) return;
    clearPartForm();
    clearProductForm();
    clearVenueForm();
    clearSaleForm();
    renderAll();
    showToast("データを初期化しました");
  });
}

function startTutorial() {
  tutorialIndex = 0;
  document.getElementById("tutorialLayer")?.removeAttribute("hidden");
  renderTutorialStep();
}

function finishTutorial() {
  if (tutorialTarget && tutorialTargetHandler) {
    tutorialTarget.removeEventListener("click", tutorialTargetHandler);
    tutorialTarget.removeEventListener("input", tutorialTargetHandler);
    tutorialTarget.removeEventListener("change", tutorialTargetHandler);
    tutorialTarget.removeEventListener("submit", tutorialTargetHandler);
  }
  tutorialTarget?.classList.remove("tutorial-target");
  tutorialTarget = null;
  tutorialTargetHandler = null;
  const backdrop = document.querySelector(".tutorial-backdrop");
  if (backdrop) backdrop.style.clipPath = "none";
  document.getElementById("tutorialLayer")?.setAttribute("hidden", "");
  localStorage.setItem(TUTORIAL_KEY, "done");
  renderFirstRunGuide();
}

function tutorialReady(step) {
  if (step.kind !== "input") return true;
  return Boolean(tutorialTarget?.value?.trim());
}

function moveTutorial(direction) {
  const step = tutorialSteps[tutorialIndex];
  if (direction > 0 && step.kind === "input" && !tutorialReady(step)) {
    const message = document.getElementById("tutorialMessage");
    if (message) message.textContent = "入力欄に内容を入力してから、次へ進んでください。";
    tutorialTarget?.focus();
    return;
  }
  if (direction > 0 && step.kind === "save" && tutorialTarget) {
    // 「次へ」でも保存処理を実行できるようにする。
    // 保存ボタン側のハンドラーが保存完了後に次のステップへ進める。
    tutorialTarget.click();
    return;
  }
  if (direction > 0 && step.kind === "click" && tutorialTarget) {
    const currentIndex = tutorialIndex;
    tutorialTarget.click();
    if (tutorialIndex === currentIndex) {
      tutorialIndex += 1;
      renderTutorialStep();
    }
    return;
  }
  const next = tutorialIndex + direction;
  if (next >= tutorialSteps.length) {
    finishTutorial();
    return;
  }
  tutorialIndex = Math.max(0, next);
  renderTutorialStep();
}

function renderTutorialStep() {
  const layer = document.getElementById("tutorialLayer");
  const tip = document.getElementById("tutorialTip");
  const title = document.getElementById("tutorialTitle");
  const message = document.getElementById("tutorialMessage");
  const label = document.getElementById("tutorialStepLabel");
  const nextButton = document.getElementById("tutorialNextBtn");
  const backButton = document.getElementById("tutorialBackBtn");
  if (!layer || !tip || !title || !message || !label || !nextButton || !backButton) return;

  if (tutorialTarget && tutorialTargetHandler) {
    tutorialTarget.removeEventListener("click", tutorialTargetHandler);
    tutorialTarget.removeEventListener("input", tutorialTargetHandler);
    tutorialTarget.removeEventListener("change", tutorialTargetHandler);
    tutorialTarget.removeEventListener("submit", tutorialTargetHandler);
  }
  tutorialTarget?.classList.remove("tutorial-target");
  const backdrop = document.querySelector(".tutorial-backdrop");
  if (backdrop) backdrop.style.clipPath = "none";

  const step = tutorialSteps[tutorialIndex];
  activateTutorialView(step?.view);
  if (step?.kind !== "click") {
    if (step?.view === "parts") openPartEditor();
    if (step?.view === "products") openProductEditor();
    if (step?.view === "venues") openVenueEditor();
  }
  const target = step.target();
  tutorialTarget = target;
  title.textContent = step.title;
  message.textContent = step.message;
  label.textContent = `${tutorialIndex + 1} / ${tutorialSteps.length}`;
  backButton.disabled = tutorialIndex === 0;
  nextButton.textContent = step.kind === "done" ? "完了" : "次へ";
  // クリック対象の操作が環境によって拾えない場合でも、案内を止めない。
  // 入力ステップだけは、入力内容が入るまで次へ進めない。
  nextButton.disabled = step.kind === "input" && !tutorialReady(step);

  if (target) {
    target.classList.add("tutorial-target");
    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    if (step.kind === "input") target.focus({ preventScroll: true });
    tutorialTargetHandler = () => {
      if (step.kind === "input") {
        nextButton.disabled = !tutorialReady(step);
        return;
      }
      if (step.kind === "save") {
        window.setTimeout(() => moveTutorial(1), 300);
        return;
      }
      moveTutorial(1);
    };
    if (step.kind === "click") target.addEventListener("click", tutorialTargetHandler, { once: true });
    if (step.kind === "input") {
      target.addEventListener("input", tutorialTargetHandler);
      target.addEventListener("change", tutorialTargetHandler);
    }
    if (step.kind === "save") target.addEventListener("click", tutorialTargetHandler, { once: true });
    requestAnimationFrame(() => positionTutorialTip(target, tip));
  } else {
    requestAnimationFrame(() => {
      tip.style.left = "50%";
      tip.style.top = "50%";
      tip.style.transform = "translate(-50%, -50%)";
    });
  }
}

function activateTutorialView(viewId) {
  if (!viewId) return;
  const view = document.getElementById(viewId);
  const navItem = document.querySelector(`.nav-item[data-view="${viewId}"]`);
  if (!view || !navItem) return;
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item === navItem;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item === view));
  const title = document.getElementById("view-title");
  if (title) title.textContent = views[viewId] || "";
}

function positionTutorialTip(target, tip) {
  const rect = target.getBoundingClientRect();
  const backdrop = document.querySelector(".tutorial-backdrop");
  if (backdrop) {
    const pad = 8;
    const left = Math.max(0, rect.left - pad);
    const top = Math.max(0, rect.top - pad);
    const right = Math.min(window.innerWidth, rect.right + pad);
    const bottom = Math.min(window.innerHeight, rect.bottom + pad);
    backdrop.style.clipPath = `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${bottom}px, ${left}px ${bottom}px, ${left}px ${top}px, ${right}px ${top}px, ${right}px ${bottom}px, 0 ${bottom}px)`;
  }
  const tipWidth = Math.min(360, window.innerWidth - 32);
  const left = Math.max(16, Math.min(window.innerWidth - tipWidth - 16, rect.left));
  const top = rect.bottom + 16 + 220 < window.innerHeight ? rect.bottom + 16 : Math.max(16, rect.top - 220);
  tip.style.width = `${tipWidth}px`;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.style.transform = "none";
}

window.addEventListener("resize", () => {
  if (tutorialTarget && !document.getElementById("tutorialLayer")?.hidden) {
    positionTutorialTip(tutorialTarget, document.getElementById("tutorialTip"));
  }
});

function recordStockAdjustment({ itemType, itemId, itemName, before, after, reason }) {
  if (toNumber(before) === toNumber(after)) return;
  state.stockAdjustments = Array.isArray(state.stockAdjustments) ? state.stockAdjustments : [];
  state.stockAdjustments.unshift({
    id: uid("adjustment"),
    at: new Date().toISOString(),
    userId: "owner",
    itemType,
    itemId,
    itemName,
    before: toNumber(before),
    after: toNumber(after),
    delta: toNumber(after) - toNumber(before),
    reason,
  });
  state.stockAdjustments = state.stockAdjustments.slice(0, 200);
}

async function savePart(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const existing = state.parts.find((part) => part.id === data.get("id"));
  const imageFile = data.get("image");
  const image = imageFile?.size
    ? await fileToDataUrl(imageFile)
    : data.get("removeImage") === "1" ? "" : existing?.image || "";
  const purchases = [...(existing?.purchases || [])];
  let stock = toNumber(data.get("stock"));
  const initialCost = toNumber(data.get("initialCost"));
  let cost = existing ? toNumber(existing.cost) : initialCost;
  const purchaseQty = toNumber(data.get("purchaseQty"));
  const purchaseCost = toNumber(data.get("purchaseCost"));
  const purchaseSupplier = data.get("purchaseSupplier").trim();
  const purchaseDate = data.get("purchaseDateNew");

  if (!existing && stock > 0 && initialCost > 0) {
    purchases.push(createPurchase({
      qty: stock,
      unitCost: initialCost,
      supplier: data.get("supplier").trim(),
      date: data.get("purchaseDate"),
      memo: "初期登録",
    }));
  }

  if (purchaseQty > 0) {
    const valueBefore = stock * cost;
    const valueAdded = purchaseQty * purchaseCost;
    stock += purchaseQty;
    cost = stock > 0 ? Math.round((valueBefore + valueAdded) / stock) : purchaseCost;
    purchases.push(createPurchase({
      qty: purchaseQty,
      unitCost: purchaseCost,
      supplier: purchaseSupplier,
      date: purchaseDate,
      memo: "追加仕入",
    }));
  }

  const latestPurchase = purchases[purchases.length - 1];
  const part = {
    id: data.get("id") || uid("part"),
    name: data.get("name").trim(),
    category: data.get("category")?.trim() || "",
    kind: data.get("kind"),
    stock,
    minStock: toNumber(data.get("minStock")),
    unit: data.get("unit").trim() || "個",
    initialCost,
    cost,
    location: data.get("location").trim(),
    supplier: latestPurchase?.supplier || data.get("supplier").trim(),
    initialPurchaseDate: existing?.initialPurchaseDate || data.get("purchaseDate"),
    purchaseDate: latestPurchase?.date || existing?.purchaseDate || data.get("purchaseDate"),
    purchases,
    image,
    barcode: data.get("barcode").trim(),
    memo: data.get("memo").trim(),
  };
  recordStockAdjustment({
    itemType: "part",
    itemId: part.id,
    itemName: part.name,
    before: existing?.stock || 0,
    after: part.stock,
    reason: existing ? "部品編集・在庫変更" : "部品の初期在庫登録",
  });
  upsert(state.parts, part);
  state.masters = normalizeMasters({
    ...state.masters,
    partCategories: [...(state.masters?.partCategories || []), part.category],
    suppliers: [...(state.masters?.suppliers || []), part.supplier, purchaseSupplier],
  }, state.parts);
  if (!saveState()) return;
  clearPartForm();
  closeCatalogDrawer("partEditorDrawer");
  renderAll();
  showToast("部品を保存しました");
}

function savePurchase(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const purchaseId = data.get("id");
  const supplier = String(data.get("supplier") || "").trim();
  const date = data.get("date");
  const memo = String(data.get("memo") || "").trim();
  const lines = [...form.querySelectorAll("[data-purchase-line]")].map((line) => ({
    line,
    mode: line.dataset.mode || "existing",
    partId: line.querySelector("[name=batchPartId]")?.value || "",
    partName: String(line.querySelector("[name=batchPartName]")?.value || "").trim(),
    qty: toNumber(line.querySelector("[name=batchQty]")?.value),
    unitCost: toNumber(line.querySelector("[name=batchUnitCost]")?.value),
  }));
  const partIds = lines.filter((entry) => entry.mode === "existing").map((entry) => entry.partId).filter(Boolean);
  const newNames = lines.filter((entry) => entry.mode === "new").map((entry) => entry.partName.toLowerCase());
  if (!supplier || !date || !lines.length || lines.some((entry) => (
    (entry.mode === "existing" && !entry.partId) ||
    (entry.mode === "new" && !entry.partName) ||
    entry.qty <= 0 || entry.unitCost < 0
  ))) {
    showToast("仕入先・購入日・部品名・数量・仕入単価を確認してください");
    return;
  }
  if (new Set(partIds).size !== partIds.length || new Set(newNames).size !== newNames.length) {
    showToast("同じ部品が複数行にあります。数量を1行にまとめてください");
    return;
  }
  if (purchaseId && lines.length !== 1) {
    showToast("既存の仕入履歴を編集する場合は1行で入力してください");
    return;
  }
  const originalPart = state.parts.find((entry) => entry.id === (data.get("originalPartId") || lines[0].partId));
  const oldPurchase = originalPart?.purchases?.find((entry) => entry.id === purchaseId);
  const batchId = lines.length > 1 ? uid("purchase_batch") : (oldPurchase?.batchId || "");
  if (oldPurchase && originalPart && toNumber(originalPart.stock) < toNumber(oldPurchase.qty)) {
    showToast("この仕入履歴は現在庫より多く、編集できません。先に棚卸しで在庫を確認してください。");
    return;
  }
  if (oldPurchase && originalPart) {
    originalPart.stock = Math.max(0, toNumber(originalPart.stock) - toNumber(oldPurchase.qty));
    originalPart.purchases = originalPart.purchases.filter((entry) => entry.id !== purchaseId);
    recalculatePartCost(originalPart);
  }
  lines.forEach(({ mode, partId, partName, qty, unitCost }) => {
    let part = state.parts.find((entry) => entry.id === partId);
    if (!part && mode === "new") {
      part = {
        id: uid("part"),
        name: partName,
        category: "",
        kind: "other",
        stock: 0,
        minStock: 0,
        unit: "個",
        initialCost: unitCost,
        cost: unitCost,
        location: "",
        supplier,
        initialPurchaseDate: date,
        purchaseDate: date,
        purchases: [],
        image: "",
        barcode: "",
        memo: "",
      };
      state.parts.push(part);
    }
    if (!part) return;
    const beforeValue = toNumber(part.stock) * toNumber(part.cost);
    const addedValue = qty * unitCost;
    part.stock = toNumber(part.stock) + qty;
    part.cost = part.stock > 0 ? Math.round((beforeValue + addedValue) / part.stock) : unitCost;
    part.supplier = supplier;
    part.purchaseDate = date;
    part.purchases = part.purchases || [];
    part.purchases.unshift(normalizePurchase({
      id: purchaseId || uid("purchase"),
      date,
      supplier,
      qty,
      unitCost,
      memo,
      batchId,
      batchSize: lines.length,
    }));
    part.purchases = part.purchases.slice(0, 200);
  });
  state.masters = normalizeMasters({
    ...state.masters,
    suppliers: [...(state.masters?.suppliers || []), supplier],
  }, state.parts);
  if (!saveState({ action: "仕入れ・入荷登録" })) return;
  clearPurchaseForm();
  renderAll();
  showToast(`${lines.length}件の仕入れ・入荷を保存しました`);
}

function recalculatePartCost(part) {
  const purchases = part.purchases || [];
  const quantity = purchases.reduce((sum, purchase) => sum + toNumber(purchase.qty), 0);
  const value = purchases.reduce((sum, purchase) => sum + toNumber(purchase.total), 0);
  if (quantity > 0) part.cost = Math.round(value / quantity);
}

function createPurchase({ qty, unitCost, supplier, date, memo }) {
  return normalizePurchase({
    id: uid("purchase"),
    qty,
    unitCost,
    supplier,
    date,
    memo,
  });
}

async function saveProduct(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const existing = state.products.find((product) => product.id === data.get("id"));
  const imageFile = data.get("image");
  const product = {
    id: data.get("id") || uid("product"),
    name: data.get("name").trim(),
    category: data.get("category").trim(),
    stock: Math.floor(toNumber(data.get("stock"))),
    minStock: Math.floor(toNumber(data.get("minStock"))),
    price: toNumber(data.get("price")),
    unitCost: toNumber(existing?.unitCost),
    productions: existing?.productions || [],
    image: imageFile?.size
      ? await fileToDataUrl(imageFile)
      : data.get("removeImage") === "1" ? "" : existing?.image || "",
    barcode: data.get("barcode").trim(),
    recipe: readRecipeRows(),
    memo: data.get("memo").trim(),
  };
  if (!product.unitCost) product.unitCost = recipeCost(product);
  recordStockAdjustment({
    itemType: "product",
    itemId: product.id,
    itemName: product.name,
    before: existing?.stock || 0,
    after: product.stock,
    reason: existing ? "商品編集・在庫変更" : "商品の初期在庫登録",
  });
  upsert(state.products, product);
  if (!saveState()) return;
  clearProductForm();
  closeCatalogDrawer("productEditorDrawer");
  renderAll();
  showToast("商品を保存しました");
}

async function saveProduction(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const product = state.products.find((entry) => entry.id === data.get("productId"));
  const quantity = Math.floor(toNumber(data.get("quantity")));
  if (!product || quantity <= 0) return;

  const shortage = productionShortage(product, quantity);
  if (shortage.length) {
    await showMessage("部品在庫が不足しています", shortage.join("\n"));
    return;
  }

  const unitCost = recipeCost(product);
  const previousStock = Math.floor(toNumber(product.stock));
  const previousUnitCost = productCost(product);
  const usedParts = product.recipe.map((row) => {
    const part = state.parts.find((entry) => entry.id === row.partId);
    return {
      partId: row.partId,
      partName: part?.name || "削除済み部品",
      qty: toNumber(row.qty) * quantity,
      unit: part?.unit || "",
      unitCost: toNumber(part?.cost),
    };
  });

  product.recipe.forEach((row) => {
    const part = state.parts.find((entry) => entry.id === row.partId);
    if (part) part.stock = toNumber(part.stock) - toNumber(row.qty) * quantity;
  });
  product.stock = previousStock + quantity;
  product.unitCost = product.stock > 0
    ? Math.round(((previousStock * previousUnitCost) + (quantity * unitCost)) / product.stock)
    : unitCost;
  product.productions = product.productions || [];
  product.productions.push(normalizeProductionRecord({
    id: uid("production"),
    date: new Date().toISOString().slice(0, 10),
    quantity,
    unitCost,
    totalCost: quantity * unitCost,
    parts: usedParts,
  }));
  if (!saveState()) return;
  event.currentTarget.reset();
  closeCatalogDrawer("productEditorDrawer");
  renderAll();
  showToast(`${product.name}を${quantity}点作成しました`);
}

async function saveVenue(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const existing = state.venues.find((venue) => venue.id === data.get("id"));
  const files = [...form.elements.images.files];
  const removedImages = JSON.parse(data.get("removeImages") || "[]");
  const previousImages = (existing?.images || []).filter((_, index) => !removedImages.includes(index));
  const addedImages = files.length ? await Promise.all(files.map(fileToDataUrl)) : [];
  const images = data.get("replaceImages") === "on"
    ? addedImages
    : [...previousImages, ...addedImages];
  const venue = {
    id: data.get("id") || uid("venue"),
    eventName: data.get("eventName").trim(),
    date: data.get("date"),
    applicationDeadline: data.get("applicationDeadline") || "",
    resultScheduledDate: data.get("resultScheduledDate") || "",
    actualOperationDate: data.get("actualOperationDate") || "",
    placeName: data.get("placeName").trim(),
    prefecture: data.get("prefecture") || "",
    address: data.get("address").trim(),
    boothFee: toNumber(data.get("boothFee")),
    parkingFee: toNumber(data.get("parkingFee")),
    transportFee: toNumber(data.get("transportFee")),
    otherFee: toNumber(data.get("otherFee")),
    plannedProductQty: Math.floor(toNumber(data.get("plannedProductQty"))),
    cashFloat: toNumber(data.get("cashFloat")),
    status: existing?.status || "planned",
    openedAt: existing?.openedAt || "",
    closedAt: existing?.closedAt || "",
    settlement: existing?.settlement || null,
    prepItems: data.get("prepItems").trim(),
    parkingLocation: data.get("parkingLocation").trim(),
    transportTrips: Math.floor(toNumber(data.get("transportTrips"))),
    carriedProducts: readVenueCarryRows(),
    plannedProducts: readVenuePlanRows(),
    fixtures: data.get("fixtures").trim(),
    review: data.get("review").trim(),
    customNotes: data.get("customNotes").trim(),
    prepChecklist: readPrepChecklist(),
    images,
    memo: data.get("memo").trim(),
  };
  upsert(state.venues, venue);
  if (!saveState()) return;
  clearVenueForm();
  closeVenueEditor();
  renderAll();
  showToast("出展イベントを保存しました");
}

function saveExpense(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const expense = normalizeExpense({
    id: data.get("id") || uid("expense"),
    date: data.get("date"),
    category: data.get("category").trim(),
    amount: data.get("amount"),
    venueId: data.get("venueId"),
    memo: data.get("memo").trim(),
  });
  upsert(state.expenses, expense);
  if (!saveState()) return;
  form.reset();
  setTodayDefaults();
  renderAll();
  showToast("費用を保存しました");
}

function saleAttributesFromData(data) {
  return {
    soldTime: data.get("soldTime") || "",
    customerGender: data.get("customerGender") || "unknown",
    customerAgeGroup: data.get("customerAgeGroup") || "unknown",
    customerOrigin: data.get("customerOrigin") || "unknown",
    customerRegion: data.get("customerRegion") || "unknown",
  };
}

async function saveSale(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const id = data.get("id");
  const quantity = toNumber(data.get("quantity"));
  const unitPrice = toNumber(data.get("unitPrice"));
  const grossTotal = quantity * unitPrice;
  const discountAmount = Math.min(grossTotal, Math.max(0, toNumber(data.get("discountAmount"))));
  const total = Math.max(0, grossTotal - discountAmount);
  const paymentMethod = data.get("paymentMethod") === "cashless" ? "cashless" : "cash";
  const itemType = data.get("itemType");
  const itemId = data.get("itemId");
  if (!itemId || quantity <= 0) return;

  const itemList = itemType === "product" ? state.products : state.parts;
  const item = itemList.find((entry) => entry.id === itemId);
  if (!item) return;
  const venue = state.venues.find((entry) => entry.id === data.get("venueId"));
  const existing = state.sales.find((sale) => sale.id === id);
  if (existing && venue?.status === "closed") {
    const ok = await showConfirm("締め処理後の販売を編集しますか？", "このイベントは締め処理済みです。編集すると締め結果と再確認が必要になります。");
    if (!ok) return;
  }
  if (!existing && venue?.status === "closed") {
    await showMessage("締め処理済みのため登録できません", "このイベントは締め処理済みです。イベント画面から再開してから販売を登録してください。");
    return;
  }
  const unitCostAtSale = existing?.itemType === itemType && existing?.itemId === itemId
    ? toNumber(existing.unitCostAtSale)
    : itemUnitCost(itemType, itemId);
  const availableStock = toNumber(item.stock)
    + (existing?.itemType === itemType && existing?.itemId === itemId ? toNumber(existing.quantity) : 0);
  if (quantity > availableStock) {
    await showMessage("在庫不足", `${item.name}の在庫は${availableStock}です。販売数量を確認してください。`);
    return;
  }
  if (existing) restoreSaleStock(existing);
  item.stock = toNumber(item.stock) - quantity;

  const editHistory = existing?.editHistory ? [...existing.editHistory] : [];
  if (existing) {
    editHistory.push({
      at: new Date().toISOString(),
      action: "販売編集",
      before: { quantity: existing.quantity, unitPrice: existing.unitPrice, total: existing.total, discountAmount: existing.discountAmount || 0, discountReason: existing.discountReason || "", soldTime: existing.soldTime || "" },
    });
  }

  const sale = {
    id: id || uid("sale"),
    date: data.get("date"),
    venueId: data.get("venueId"),
    venueLabel: venue ? eventLabel(venue) : "出展イベント未設定",
    itemType,
    itemId,
    itemName: item.name,
    quantity,
    unitPrice,
    total,
    discountAmount,
    discountReason: data.get("discountReason")?.trim() || "",
    paymentMethod,
    unitCostAtSale,
    costAtSale: unitCostAtSale * quantity,
    receivedAmount: paymentMethod === "cash" ? toNumber(data.get("receivedAmount")) : 0,
    changeDue: paymentMethod === "cash" ? Math.max(0, toNumber(data.get("receivedAmount")) - total) : 0,
    checkoutId: existing?.checkoutId || "",
    status: existing?.status || "active",
    cancelledAt: existing?.cancelledAt || "",
    editHistory,
    refundHistory: existing?.refundHistory || [],
    memo: data.get("memo").trim(),
    ...saleAttributesFromData(data),
  };
  upsert(state.sales, sale);
  if (!saveState()) return;
  clearSaleForm();
  renderAll();
  showToast("販売を記録しました");
}

async function saveDashboardSale(event) {
  event.preventDefault();
  const venue = currentDashboardVenue();
  if (!venue) {
    await showMessage("イベントを選択してください", "販売を記録する前に、出展イベントを登録または選択してください。");
    return;
  }

  const form = event.currentTarget;
  const data = new FormData(form);
  const quantity = toNumber(data.get("quantity"));
  const unitPrice = toNumber(data.get("unitPrice"));
  const itemType = data.get("itemType");
  const itemId = data.get("itemId");
  if (!itemId || quantity <= 0) return;

  const itemList = itemType === "product" ? state.products : state.parts;
  const item = itemList.find((entry) => entry.id === itemId);
  if (!item) return;
  const unitCostAtSale = itemUnitCost(itemType, itemId);
  const availableStock = toNumber(item.stock);
  if (quantity > availableStock) {
    await showMessage("在庫不足", `${item.name}の在庫は${availableStock}です。販売数量を確認してください。`);
    return;
  }
  item.stock = availableStock - quantity;

  state.sales.unshift({
    id: uid("sale"),
    date: venue.date || new Date().toISOString().slice(0, 10),
    venueId: venue.id,
    venueLabel: eventLabel(venue),
    itemType,
    itemId,
    itemName: item.name,
    quantity,
    unitPrice,
    total: quantity * unitPrice,
    paymentMethod: data.get("paymentMethod") === "cashless" ? "cashless" : "cash",
    unitCostAtSale,
    costAtSale: unitCostAtSale * quantity,
    receivedAmount: toNumber(data.get("receivedAmount")),
    changeDue: Math.max(0, toNumber(data.get("receivedAmount")) - quantity * unitPrice),
    memo: data.get("memo").trim(),
    ...saleAttributesFromData(data),
  });

  if (!saveState()) return;
  form.reset();
  document.getElementById("dashboardSaleItemType").value = itemType;
  renderAll();
  renderDashboardPos();
  showToast("ホームから販売を記録しました");
}

async function saveRegisterSale(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const venue = state.venues.find((entry) => entry.id === new FormData(form).get("venueId"));
  if (!venue) {
    await showMessage("イベントを選択してください", "レジで保存する前に、出展イベントを登録または選択してください。");
    return;
  }
  if (venue.status === "closed") {
    await showMessage("販売を再開してください", "このイベントは締め処理済みです。イベント画面から販売を再開してから記録してください。");
    return;
  }

  if (!registerCart.length) addRegisterLine();
  if (!registerCart.length) return;

  const requestedByItem = new Map();
  registerCart.forEach((line) => {
    const key = `${line.itemType}:${line.itemId}`;
    requestedByItem.set(key, (requestedByItem.get(key) || 0) + line.quantity);
  });
  for (const [key, requested] of requestedByItem) {
    const [itemType, itemId] = key.split(":");
    const itemList = itemType === "product" ? state.products : state.parts;
    const item = itemList.find((entry) => entry.id === itemId);
    if (!item) {
      await showMessage("販売できません", "カート内の商品が見つかりません。明細を確認してください。");
      return;
    }
    if (requested > toNumber(item.stock)) {
      await showMessage("在庫不足", `${item.name}の在庫は${item.stock}です。カートの数量を確認してください。`);
      return;
    }
  }

  const paymentMethod = form.elements.paymentMethod.value === "cashless" ? "cashless" : "cash";
  const receivedAmount = paymentMethod === "cash" ? toNumber(document.getElementById("registerReceived").value) : 0;
  const discountAmount = registerDiscountAmount();
  const total = registerPayableTotal();
  const saleAttributes = saleAttributesFromData(new FormData(form));
  const checkoutId = uid("checkout");
  registerCart.forEach((line) => {
    const itemList = line.itemType === "product" ? state.products : state.parts;
    const item = itemList.find((entry) => entry.id === line.itemId);
    if (item) item.stock = toNumber(item.stock) - line.quantity;
  });
  const sales = registerCart.map((line, index) => ({
    id: uid("sale"),
    date: venue.date || new Date().toISOString().slice(0, 10),
    venueId: venue.id,
    venueLabel: eventLabel(venue),
    itemType: line.itemType,
    itemId: line.itemId,
    itemName: line.itemName,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    total: index === 0 ? Math.max(0, line.total - discountAmount) : line.total,
    discountAmount: index === 0 ? discountAmount : 0,
    discountReason: index === 0 ? (form.elements.discountReason?.value.trim() || "") : "",
    paymentMethod,
    unitCostAtSale: line.unitCostAtSale,
    costAtSale: line.costAtSale,
    receivedAmount: index === 0 ? receivedAmount : 0,
    changeDue: index === 0 ? Math.max(0, receivedAmount - total) : 0,
    memo: form.elements.memo.value.trim(),
    checkoutId,
    ...saleAttributes,
  }));
  state.sales.unshift(...sales);
  if (!saveState()) return;
  registerLastCheckoutId = checkoutId;
  registerLastTotal = total;
  form.reset();
  registerCart = [];
  selectedRegisterItem = null;
  syncCustomerRegionFields(form);
  renderAll();
  setRegisterScreen("complete");
  showToast(`会計を保存しました。おつり ${yen.format(Math.max(0, receivedAmount - total))}`);
}

function buildRegisterLineFromCurrentInput() {
  const itemType = selectedRegisterItem?.itemType || document.getElementById("registerItemType").value;
  const itemId = selectedRegisterItem?.itemId || document.getElementById("registerItem").value;
  const quantity = toNumber(document.getElementById("registerQuantity").value);
  const unitPrice = toNumber(document.getElementById("registerUnitPrice").value);
  if (!itemId || quantity <= 0) return null;

  const item = (itemType === "product" ? state.products : state.parts).find((entry) => entry.id === itemId);
  if (!item) return null;
  const unitCostAtSale = itemUnitCost(itemType, itemId);
  return {
    id: uid("line"),
    itemType,
    itemId,
    itemName: item.name,
    quantity,
    unitPrice,
    total: quantity * unitPrice,
    unitCostAtSale,
    costAtSale: unitCostAtSale * quantity,
  };
}

function upsert(collection, item) {
  const index = collection.findIndex((entry) => entry.id === item.id);
  if (index >= 0) collection[index] = item;
  else collection.unshift(item);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
        resolve(reader.result);
        return;
      }
      const image = new Image();
      image.onload = () => {
        const maxSide = 1600;
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(reader.result);
          return;
        }
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      image.onerror = () => resolve(reader.result);
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function bindImagePreview(inputSelector, previewId, multiple = false) {
  const input = document.querySelector(inputSelector);
  const preview = document.getElementById(previewId);
  if (!input || !preview) return;
  input.addEventListener("change", async () => {
    const files = [...input.files].slice(0, multiple ? 6 : 1);
    if (!files.length) {
      preview.replaceChildren();
      return;
    }
    const invalid = files.find((file) => !file.type.startsWith("image/") || file.size > 10 * 1024 * 1024);
    if (invalid) {
      input.value = "";
      preview.textContent = "画像は10MB以下の画像ファイルを選択してください。";
      showToast("画像を読み込めません。形式または容量を確認してください。");
      return;
    }
    preview.textContent = "画像を読み込み中…";
    const urls = await Promise.all(files.map(fileToDataUrl));
    renderImagePreview(preview, urls, {
      actionLabel: "選択を解除",
      onRemove: () => {
        input.value = "";
        preview.replaceChildren();
      },
    });
    const removeField = input.form?.elements.removeImage;
    if (removeField) removeField.value = "0";
  });
}

function renderImagePreview(preview, urls = [], options = {}) {
  if (!preview) return;
  preview.replaceChildren();
  if (!urls.filter(Boolean).length) return;
  urls.filter(Boolean).forEach((url) => {
    const item = document.createElement("div");
    item.className = "image-preview-item";
    const image = document.createElement("img");
    image.src = url;
    image.alt = "選択した画像のプレビュー";
    item.appendChild(image);
    if (options.onRemove) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "image-remove-button";
      button.textContent = options.actionLabel || "削除";
      button.addEventListener("click", () => options.onRemove(url));
      item.appendChild(button);
    }
    preview.appendChild(item);
  });
}

function renderVenueSavedImages(form, images = []) {
  const preview = document.getElementById("venueImagePreview");
  if (!preview) return;
  const removed = JSON.parse(form.elements.removeImages.value || "[]");
  preview.replaceChildren();
  images.forEach((url, index) => {
    if (!url || removed.includes(index)) return;
    const item = document.createElement("div");
    item.className = "image-preview-item";
    const image = document.createElement("img");
    image.src = url;
    image.alt = `保存済みイベント画像 ${index + 1}`;
    item.appendChild(image);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "image-remove-button";
    button.textContent = "画像を削除";
    button.addEventListener("click", () => {
      const next = [...removed, index];
      form.elements.removeImages.value = JSON.stringify(next);
      renderVenueSavedImages(form, images);
    });
    item.appendChild(button);
    preview.appendChild(item);
  });
}

function renderAll() {
  applyAccessibilityLabels();
  renderFirstRunGuide();
  renderDashboard();
  renderPartMasterOptions();
  renderPartAverageCost();
  renderParts();
  renderProducts();
  renderVenues();
  renderCalendar();
  keepVenueListIndependent();
  renderVenueDaySalesSummary();
  renderEventWorkflow();
  renderPurchases();
  renderProductionOptions();
  renderSaleOptions();
  renderRegisterOptions();
  renderSales();
  renderSalesAnalysis();
  renderStockHistory();
  renderExpenseOptions();
  renderExpenses();
  renderManagement();
  renderDataManagement();
  renderRecipePartOptions();
  renderBackupStatus();
  refreshTutorialAfterRender();
}

function applyAccessibilityLabels() {
  document.getElementById("storageStatus")?.setAttribute("aria-live", "polite");
  document.getElementById("toastStack")?.setAttribute("aria-live", "polite");
  document.querySelectorAll("[data-delete-part], [data-delete-product], [data-delete-venue], [data-delete-sale], [data-delete-expense]").forEach((button) => {
    if (!button.title) button.title = "このデータを削除します。履歴や在庫への影響を確認してください。";
  });
  document.querySelectorAll("[data-cancel-sale]").forEach((button) => {
    button.title = "売上を取消し、在庫へ戻します。履歴は取消済みとして残ります。";
  });
}

function refreshTutorialAfterRender() {
  const layer = document.getElementById("tutorialLayer");
  if (!tutorialTarget || !layer || layer.hidden) return;
  requestAnimationFrame(() => {
    const step = tutorialSteps[tutorialIndex];
    const freshTarget = step?.target?.();
    if (!freshTarget) return;
    // 保存後の再描画で対象要素が差し替わっても、案内を新しい要素へ結び直す。
    if (freshTarget !== tutorialTarget) {
      renderTutorialStep();
      return;
    }
    positionTutorialTip(freshTarget, document.getElementById("tutorialTip"));
  });
}

function renderFirstRunGuide() {
  const guide = document.getElementById("firstRunGuide");
  if (!guide) return;
  const hasData = state.parts.length || state.products.length || state.venues.length || state.sales.length;
  const completed = localStorage.getItem(TUTORIAL_KEY) === "done";
  guide.hidden = Boolean(hasData || completed);
}

function renderDashboard() {
  const partsValue = state.parts.reduce((sum, part) => sum + toNumber(part.stock) * toNumber(part.cost), 0);
  const productsValue = state.products.reduce((sum, product) => sum + toNumber(product.stock) * productCost(product), 0);
  const activeSales = state.sales.filter(saleIsActive);
  const salesTotal = activeSales.reduce((sum, sale) => sum + toNumber(sale.total), 0);
  const salesCostTotal = activeSales.reduce((sum, sale) => sum + saleCost(sale), 0);
  const expenseTotal = totalEventExpenses() + legacyExpenseTotal();
  document.getElementById("partsValue").textContent = yen.format(partsValue);
  document.getElementById("productsValue").textContent = yen.format(productsValue);
  document.getElementById("salesTotal").textContent = yen.format(salesTotal);
  document.getElementById("expenseTotal").textContent = yen.format(expenseTotal);
  document.getElementById("roughProfit").textContent = yen.format(salesTotal - salesCostTotal - expenseTotal);

  const recent = activeSales.slice(0, 5).map((sale) => rowItem(
    `${sale.date} ${sale.itemName}`,
    `${sale.quantity}点 × ${yen.format(sale.unitPrice)} / ${saleVenueName(sale)} / 売上 ${yen.format(sale.total)} / 粗利 ${yen.format(saleProfit(sale))}${sale.receivedAmount ? ` / 預かり ${yen.format(sale.receivedAmount)} / おつり ${yen.format(sale.changeDue || 0)}` : ""}`,
    `<button class="ghost-button" data-edit-sale="${sale.id}">訂正</button><button class="ghost-button" data-cancel-sale="${sale.id}">取消</button>`
  ));
  fillList("recentSales", recent, "販売履歴はまだありません");

  const alerts = [
    ...state.parts.filter((part) => toNumber(part.stock) <= Math.max(0, toNumber(part.minStock))).map((part) => rowItem(part.name, `部品在庫 ${part.stock}${part.unit} / 最低 ${toNumber(part.minStock)}${part.unit}`)),
    ...state.products.filter((product) => toNumber(product.stock) <= Math.max(0, toNumber(product.minStock))).map((product) => rowItem(product.name, `商品在庫 ${product.stock}点 / 最低 ${toNumber(product.minStock)}点 / 作成可能 ${maxBuildable(product)}点`)),
  ].slice(0, 8);
  fillList("stockAlerts", alerts, "在庫切れはありません");
  renderDashboardMonthCalendar();
  renderDashboardCharts();
  if (document.getElementById("dashboardSaleForm")) renderDashboardSaleOptions();
}

function renderDashboardMonthCalendarLegacy() {
  const node = document.getElementById("dashboardMonthCalendar");
  const labelNode = document.getElementById("dashboardMonthLabel");
  if (!node || !labelNode) return;
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const monthName = `${year}年${month + 1}月`;
  labelNode.textContent = `${monthName}のカレンダー`;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const entries = calendarDateEntries();
  const dateKey = (day) => `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  let html = weekdays.map((day) => `<div class="dashboard-month-weekday">${day}</div>`).join("");
  for (let i = 0; i < firstDay; i += 1) html += `<div class="dashboard-month-day is-empty"></div>`;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = dateKey(day);
    const dayEntries = entries.filter((entry) => entry.startDate <= key && entry.endDate >= key);
    html += `<div class="dashboard-month-day${key === dateKey(today.getDate()) ? " is-today" : ""}">
      <strong>${day}</strong>
      <div>${dayEntries.slice(0, 3).map((entry) => `<button class="dashboard-month-event is-${entry.kind}" type="button" data-dashboard-calendar-entry="${entry.id}" style="--event-color:${calendarColorForEntry(entry)}"><span>${escapeHtml(entry.label)}</span><b>${escapeHtml(entry.title)}</b></button>`).join("")}</div>
      ${dayEntries.length > 3 ? `<small>ほか${dayEntries.length - 3}件</small>` : ""}
    </div>`;
  }
  node.innerHTML = `<div class="dashboard-month-grid">${html}</div>`;
  node.querySelectorAll("[data-dashboard-calendar-entry]").forEach((button) => {
    button.addEventListener("click", () => openCalendarEntryDetail(calendarEntryById(button.dataset.dashboardCalendarEntry)));
  });
}

// Overview calendar uses the same range semantics as the full calendar.
// The function is intentionally kept next to the original renderer so the
// dashboard stays compatible with existing saved calendar data.
function renderDashboardMonthCalendar() {
  const node = document.getElementById("dashboardMonthCalendar");
  const labelNode = document.getElementById("dashboardMonthLabel");
  if (!node || !labelNode) return;
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  labelNode.textContent = `${year}年${month + 1}月のカレンダー`;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const entries = calendarDateEntries();
  const keyFor = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  const localDate = (key) => {
    const [dateYear, dateMonth, dateDay] = String(key).split("-").map(Number);
    return new Date(dateYear, dateMonth - 1, dateDay);
  };
  const dateKey = (day) => `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  let html = weekdays.map((day) => `<div class="dashboard-month-weekday">${day}</div>`).join("");
  const calendarStart = new Date(year, month, 1 - firstDay);
  const totalWeeks = Math.ceil((firstDay + daysInMonth) / 7);

  for (let weekIndex = 0; weekIndex < totalWeeks; weekIndex += 1) {
    const weekStart = new Date(calendarStart.getFullYear(), calendarStart.getMonth(), calendarStart.getDate() + weekIndex * 7);
    const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6);
    const weekStartKey = keyFor(weekStart);
    const weekEndKey = keyFor(weekEnd);
    const rangeEntries = entries.filter((entry) => entry.startDate !== entry.endDate
      && entry.startDate <= weekEndKey && entry.endDate >= weekStartKey);
    let weekDays = "";

    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const current = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + dayIndex);
      if (current.getFullYear() !== year || current.getMonth() !== month) {
        weekDays += `<div class="dashboard-month-day is-empty"></div>`;
        continue;
      }
      const key = dateKey(current.getDate());
      const dayEntries = entries.filter((entry) => entry.startDate === key && entry.endDate === key);
      weekDays += `<div class="dashboard-month-day${key === dateKey(today.getDate()) ? " is-today" : ""}" data-dashboard-calendar-date="${key}" tabindex="0">
        <strong>${current.getDate()}</strong>
        <div>${dayEntries.slice(0, 3).map((entry) => `<button class="dashboard-month-event is-${entry.kind}" type="button" data-dashboard-calendar-entry="${entry.id}" style="--event-color:${calendarColorForEntry(entry)}"><span>${escapeHtml(entry.label)}</span><b>${escapeHtml(entry.title)}</b></button>`).join("")}</div>
        ${dayEntries.length > 3 ? `<small>ほか${dayEntries.length - 3}件</small>` : ""}
      </div>`;
    }

    const bars = rangeEntries.map((entry, rangeIndex) => {
      const segmentStart = Math.max(0, Math.round((localDate(entry.startDate) - weekStart) / 86400000));
      const segmentEnd = Math.min(6, Math.round((localDate(entry.endDate) - weekStart) / 86400000));
      const span = Math.max(1, segmentEnd - segmentStart + 1);
      const startsHere = entry.startDate >= weekStartKey && entry.startDate <= weekEndKey;
      const endsHere = entry.endDate >= weekStartKey && entry.endDate <= weekEndKey;
      const startLabel = startsHere ? "開始" : "継続";
      const endLabel = endsHere ? "終了" : "";
      return `<button class="dashboard-month-range-event is-${entry.kind}${startsHere ? " is-range-start" : ""}${endsHere ? " is-range-end" : ""}" type="button" data-dashboard-calendar-entry="${entry.id}" style="left:${segmentStart / 7 * 100}%;width:${span / 7 * 100}%;--range-row:${rangeIndex};--event-color:${calendarColorForEntry(entry)}" title="${escapeHtml(`${entry.title}：${entry.startDate} ～ ${entry.endDate}`)}"><span><em>${startLabel}</em><b>${escapeHtml(entry.label)}：${escapeHtml(entry.title)}</b>${endLabel ? `<em>${endLabel}</em>` : ""}</span></button>`;
    }).join("");
    html += `<div class="dashboard-month-week"><div class="dashboard-month-week-days">${weekDays}${bars}</div></div>`;
  }

  node.innerHTML = `<div class="dashboard-month-grid">${html}</div>`;
  node.onclick = (event) => {
    const entryButton = event.target.closest("[data-dashboard-calendar-entry]");
    if (entryButton) {
      event.preventDefault();
      event.stopPropagation();
      openCalendarEntryDetail(calendarEntryById(entryButton.dataset.dashboardCalendarEntry));
      return;
    }
    const dayCell = event.target.closest("[data-dashboard-calendar-date]");
    if (dayCell) openCalendarEventForm(dayCell.dataset.dashboardCalendarDate);
  };
  node.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const dayCell = event.target.closest("[data-dashboard-calendar-date]");
    if (!dayCell || event.target.closest("[data-dashboard-calendar-entry]")) return;
    event.preventDefault();
    openCalendarEventForm(dayCell.dataset.dashboardCalendarDate);
  };
}

function renderDashboardEventOptions() {
  const select = document.getElementById("dashboardEventSelect");
  const current = select.value;
  const venues = [...state.venues].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  select.innerHTML = optionList(venues, "イベントなし", eventLabel);
  if (venues.some((venue) => venue.id === current)) {
    select.value = current;
  } else if (venues[0]) {
    select.value = venues[0].id;
  }
}

function currentDashboardVenue() {
  const selectedId = document.getElementById("dashboardEventSelect").value;
  return state.venues.find((venue) => venue.id === selectedId) || null;
}

function renderDashboardEventSummary() {
  const venue = currentDashboardVenue();
  const summary = venue ? eventSalesSummary(venue.id) : null;
  document.getElementById("dashboardEventSales").textContent = yen.format(summary?.salesTotal || 0);
  document.getElementById("dashboardEventCount").textContent = `${summary?.quantityTotal || 0}点`;
  document.getElementById("dashboardEventExpense").textContent = yen.format(summary?.expenseTotal || 0);
  const profit = summary?.profit || 0;
  const profitNode = document.getElementById("dashboardEventProfit");
  profitNode.textContent = yen.format(profit);
  profitNode.classList.toggle("negative", profit < 0);
  document.getElementById("dashboardEventItems").innerHTML = summary?.items.length
    ? summary.items.map((item) => `<span>${escapeHtml(item.name)} ${item.quantity}点</span>`).join("")
    : "<span>販売記録なし</span>";
  const visual = document.getElementById("dashboardEventVisual");
  if (visual) {
    visual.innerHTML = venue?.images?.[0]
      ? `<img src="${venue.images[0]}" alt="${escapeHtml(venue.eventName)}の画像">`
      : "";
  }
}

function renderDashboardCharts() {
  renderSalesTrendChart();
  renderEventSalesChart();
  renderStockOverviewChart();
}

function dashboardSalesForPeriod(selectId = "dashboardPeriod") {
  const mode = document.getElementById(selectId)?.value || "3months";
  if (mode === "all") return state.sales.filter(saleIsActive);
  const now = new Date();
  const monthOffset = mode === "year" ? -11 : mode === "1month" ? 0 : -2;
  const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const startKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  return state.sales.filter((sale) => saleIsActive(sale) && String(sale.date || "").slice(0, 7) >= startKey);
}

function renderSalesTrendChart() {
  const svg = document.getElementById("salesTrendChart");
  if (!svg) return;
  const period = document.getElementById("dashboardPeriod");
  const periodLabel = period?.options[period.selectedIndex]?.text || "直近3か月";
  const sales = dashboardSalesForPeriod();
  const summaryNode = document.getElementById("dashboardPeriodSummary");
  if (summaryNode) summaryNode.textContent = `${periodLabel} / ${sales.length}明細`;
  const monthKeys = [...new Set(sales.map((sale) => String(sale.date || "").slice(0, 7)).filter(Boolean))]
    .sort()
    .slice(-(period?.value === "year" ? 12 : period?.value === "all" ? 120 : period?.value === "1month" ? 1 : 3));
  if (!monthKeys.length) {
    svg.innerHTML = '<text class="chart-label" x="360" y="130" text-anchor="middle">販売データが登録されると表示されます</text>';
    return;
  }
  const values = monthKeys.map((key) => sales
    .filter((sale) => String(sale.date || "").startsWith(key))
    .reduce((sum, sale) => sum + toNumber(sale.total), 0));
  const max = Math.max(...values, 1);
  const left = 48;
  const top = 18;
  const width = 640;
  const height = 160;
  const x = (index) => left + (monthKeys.length === 1 ? width / 2 : (width / (monthKeys.length - 1)) * index);
  const y = (value) => top + height - (value / max) * height;
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const area = `${left},${top + height} ${points} ${x(values.length - 1)},${top + height}`;
  const grid = [0, .5, 1].map((ratio) => {
    const lineY = top + height - height * ratio;
    const label = yen.format(Math.round(max * ratio));
    return `<line class="chart-grid-line" x1="${left}" y1="${lineY}" x2="${left + width}" y2="${lineY}"></line><text class="chart-label" x="${left - 8}" y="${lineY + 4}" text-anchor="end">${label}</text>`;
  }).join("");
  const labels = monthKeys.map((key, index) => `<text class="chart-label" x="${x(index)}" y="${top + height + 30}" text-anchor="middle">${escapeHtml(key.slice(5))}月</text>`).join("");
  const dots = values.map((value, index) => `<circle class="chart-dot" cx="${x(index)}" cy="${y(value)}" r="5"><title>${escapeHtml(monthKeys[index])}：${yen.format(value)}</title></circle>`).join("");
  svg.innerHTML = `${grid}<polygon class="chart-area" points="${area}"></polygon><polyline class="chart-line" points="${points}"></polyline>${dots}${labels}`;
}

function renderEventSalesChart() {
  const node = document.getElementById("eventSalesChart");
  if (!node) return;
  const period = document.getElementById("eventSalesPeriod");
  const periodLabel = period?.options[period.selectedIndex]?.text || "直近3か月";
  const periodSummary = document.getElementById("eventSalesPeriodSummary");
  if (periodSummary) periodSummary.textContent = `集計範囲：${periodLabel}`;
  const sales = dashboardSalesForPeriod("eventSalesPeriod");
  const rows = state.venues.map((venue) => ({
    label: eventLabel(venue),
    value: sales.filter((sale) => sale.venueId === venue.id).reduce((sum, sale) => sum + toNumber(sale.total), 0),
  })).sort((a, b) => b.value - a.value).slice(0, 5);
  const max = Math.max(...rows.map((row) => row.value), 1);
  node.innerHTML = rows.length ? rows.map((row) => `
    <div class="bar-row">
      <div class="bar-row-head"><span title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span><strong>${yen.format(row.value)}</strong></div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, row.value / max * 100)}%"></div></div>
    </div>`).join("") : '<p class="empty-note">イベントを登録すると表示されます</p>';
}

function renderStockOverviewChart() {
  const node = document.getElementById("stockOverviewChart");
  if (!node) return;
  const groups = [
    { label: "部品", items: state.parts },
    { label: "商品", items: state.products },
  ];
  node.innerHTML = groups.map((group) => {
    const total = group.items.length;
    const low = group.items.filter((item) => toNumber(item.stock) <= toNumber(item.minStock)).length;
    const ok = Math.max(0, total - low);
    const lowWidth = total ? low / total * 100 : 0;
    const okWidth = total ? ok / total * 100 : 0;
    return `<div class="stock-row">
      <div class="stock-row-head"><span>${group.label}</span><strong>${low ? `${low}件が要確認` : `${total}件・問題なし`}</strong></div>
      <div class="stock-track"><span class="stock-ok" style="width:${okWidth}%"></span><span class="stock-low" style="width:${lowWidth}%"></span></div>
    </div>`;
  }).join("");
}

function renderDashboardSaleOptions() {
  if (!document.getElementById("dashboardSaleItemType")) return;
  const form = document.getElementById("dashboardSaleForm");
  const venue = currentDashboardVenue();
  const type = document.getElementById("dashboardSaleItemType").value;
  const items = type === "product" ? state.products : state.parts;
  form?.setAttribute("aria-hidden", venue ? "false" : "true");
  const submit = form?.querySelector('button[type="submit"]');
  if (submit) submit.disabled = !venue || !items.length;
  document.getElementById("dashboardSaleItem").innerHTML = optionList(items, "品目なし");
  fillDashboardSalePrice();
}

function fillDashboardSalePrice() {
  if (!document.getElementById("dashboardSaleItemType")) return;
  const type = document.getElementById("dashboardSaleItemType").value;
  const itemId = document.getElementById("dashboardSaleItem").value;
  const item = (type === "product" ? state.products : state.parts).find((entry) => entry.id === itemId);
  const price = type === "product" ? item?.price : item?.cost;
  document.querySelector("#dashboardSaleForm [name=unitPrice]").value = price || 0;
  renderDashboardPos();
}

function renderDashboardPos() {
  if (!document.getElementById("dashboardSaleForm")) return;
  const form = document.getElementById("dashboardSaleForm");
  const quantity = toNumber(form.elements.quantity.value);
  const unitPrice = toNumber(form.elements.unitPrice.value);
  const received = toNumber(form.elements.receivedAmount.value);
  const total = quantity * unitPrice;
  const change = Math.max(0, received - total);
  document.getElementById("dashboardSaleTotal").textContent = yen.format(total);
  document.getElementById("dashboardChangeDue").value = yen.format(change);
}

function renderParts() {
  const query = document.getElementById("partSearch").value.trim().toLowerCase();
  const sort = document.getElementById("partSort")?.value || "name";
  const parts = state.parts.filter((part) => `${part.name} ${part.supplier || ""} ${part.location || ""} ${part.memo || ""}`.toLowerCase().includes(query))
    .sort((a, b) => sort === "stock" ? toNumber(a.stock) - toNumber(b.stock) : sort === "updated" ? String(b.purchaseDate || "").localeCompare(String(a.purchaseDate || "")) : String(a.name).localeCompare(String(b.name), "ja"));
  const nodes = parts.map((part) => {
    const kind = { solid: "固体", liquid: "液状", other: "その他" }[part.kind] || "その他";
    const purchases = part.purchases || [];
    const purchaseTotal = purchases.reduce((sum, purchase) => sum + toNumber(purchase.total), 0);
    return `
      <article class="tile">
        ${imageOrPlaceholder(part.image, part.name, "tile-image")}
        <h4>${escapeHtml(part.name)}</h4>
        <p>${escapeHtml(part.memo || part.location || "メモなし")}</p>
        <div class="tile-meta">
          <span class="badge">${kind}</span>
          ${part.category ? `<span class="badge">${escapeHtml(part.category)}</span>` : ""}
          <span class="badge">${part.stock}${escapeHtml(part.unit)}</span>
          <span class="badge">最低 ${toNumber(part.minStock)}${escapeHtml(part.unit)}</span>
          <span class="badge">初回 ${yen.format(part.initialCost ?? part.cost)} / ${escapeHtml(part.unit)}</span>
          <span class="badge warn">平均 ${yen.format(part.cost)} / ${escapeHtml(part.unit)}</span>
          ${part.supplier ? `<span class="badge">${escapeHtml(part.supplier)}</span>` : ""}
          ${part.purchaseDate ? `<span class="badge">${escapeHtml(part.purchaseDate)}</span>` : ""}
          ${purchases.length ? `<span class="badge good">仕入 ${purchases.length}回</span>` : ""}
        </div>
        ${purchases.length ? `
          <div class="purchase-history">
            <strong>仕入履歴 ${yen.format(purchaseTotal)}</strong>
            ${purchases.slice(-3).reverse().map((purchase) => `
              <span>${escapeHtml(purchase.date || "日付なし")} / ${escapeHtml(purchase.supplier || "仕入先なし")} / ${purchase.qty}${escapeHtml(part.unit)} × ${yen.format(purchase.unitCost)}</span>
            `).join("")}
          </div>
        ` : ""}
        <div class="tile-actions">
          <button class="primary-button" data-purchase-part="${part.id}">仕入・入荷へ</button>
          <button class="ghost-button" data-edit-part="${part.id}">編集</button>
          <button class="danger-button" data-delete-part="${part.id}">削除</button>
        </div>
      </article>`;
  });
  fillList("partList", nodes, "部品を登録してください");
  bindListActions();
}

function renderProducts() {
  const query = document.getElementById("productSearch").value.trim().toLowerCase();
  const sort = document.getElementById("productSort")?.value || "name";
  const products = state.products.filter((product) => `${product.name} ${product.category || ""}`.toLowerCase().includes(query))
    .sort((a, b) => sort === "stock" ? toNumber(a.stock) - toNumber(b.stock) : sort === "price" ? toNumber(b.price) - toNumber(a.price) : String(a.name).localeCompare(String(b.name), "ja"));
  const nodes = products.map((product) => {
    const cost = productCost(product);
    const productions = product.productions || [];
    const recipeText = product.recipe.length
      ? product.recipe.map((row) => `${partName(row.partId)} ${row.qty}`).join(" / ")
      : "使用部品未設定";
    return `
      <article class="tile">
        ${imageOrPlaceholder(product.image, product.name, "tile-image")}
        <h4>${escapeHtml(product.name)}</h4>
        <p>${escapeHtml(recipeText)}</p>
        <div class="tile-meta">
          <span class="badge">${escapeHtml(product.category || "品目未設定")}</span>
          <span class="badge">在庫 ${product.stock}点</span>
          <span class="badge">最低 ${toNumber(product.minStock)}点</span>
          <span class="badge good">作成可能 ${maxBuildable(product)}点</span>
          <span class="badge">${yen.format(product.price)}</span>
          <span class="badge warn">平均原価 ${yen.format(cost)}</span>
          ${productions.length ? `<span class="badge good">作成 ${productions.length}回</span>` : ""}
        </div>
        ${productions.length ? `
          <div class="purchase-history">
            <strong>作成履歴 ${productions.reduce((sum, record) => sum + toNumber(record.quantity), 0)}点</strong>
            ${productions.slice(-3).reverse().map((record) => `
              <span>${escapeHtml(record.date || "日付なし")} / ${record.quantity}点 / 単価 ${yen.format(record.unitCost)} / 合計 ${yen.format(record.totalCost)}</span>
            `).join("")}
          </div>
        ` : ""}
        <div class="tile-actions">
          <button class="primary-button" data-make-product="${product.id}">製作して在庫追加</button>
          <button class="ghost-button" data-edit-product="${product.id}">編集</button>
          <button class="danger-button" data-delete-product="${product.id}">削除</button>
        </div>
      </article>`;
  });
  fillList("productList", nodes, "商品を登録してください");
  bindListActions();
}

function bindCalendar() {
  const calendar = document.getElementById("eventCalendar");
  calendar?.addEventListener("click", (event) => {
    const entryButton = event.target.closest("[data-calendar-entry]");
    if (entryButton) {
      event.preventDefault();
      openCalendarEntryDetail(calendarEntryById(entryButton.dataset.calendarEntry));
      return;
    }
    const dayCell = event.target.closest("[data-calendar-date]");
    if (dayCell) {
      event.preventDefault();
      openCalendarEventForm(dayCell.dataset.calendarDate);
    }
  });
  calendar?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const dayCell = event.target.closest("[data-calendar-date]");
    if (!dayCell || event.target.closest("[data-calendar-entry]")) return;
    event.preventDefault();
    openCalendarEventForm(dayCell.dataset.calendarDate);
  });
  document.getElementById("calendarPrev")?.addEventListener("click", () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById("calendarNext")?.addEventListener("click", () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
    renderCalendar();
  });
  document.getElementById("calendarToday")?.addEventListener("click", () => {
    const today = new Date();
    calendarCursor = new Date(today.getFullYear(), today.getMonth(), 1);
    renderCalendar();
  });
  bindCalendarModal();
}

function calendarDateEntries() {
  const fields = [
    ["applicationDeadline", "申込期限", "application"],
    ["resultScheduledDate", "合否予定日", "result"],
    ["date", "開催予定", "event"],
    ["actualOperationDate", "実際の稼働", "actual"],
  ];
  const venueEntries = state.venues.flatMap((venue) => fields
    .filter(([field]) => venue[field])
    .map(([field, label, kind]) => ({
      id: `venue:${venue.id}:${field}`,
      date: venue[field],
      startDate: venue[field],
      endDate: venue[field],
      label,
      title: eventLabel(venue),
      kind,
      venue,
      field,
      color: "",
      memo: venue.memo || "",
      system: true,
    })));
  const customEntries = state.calendarEvents.map((event) => ({
    ...event,
    id: `custom:${event.id}`,
    date: event.startDate,
    label: { application: "申込期限", result: "合否予定日", event: "開催日", other: "その他" }[event.type] || "その他",
    kind: event.type,
    system: false,
  }));
  return [...venueEntries, ...customEntries];
}

function openCalendarVenue(id) {
  document.querySelector('.nav-item[data-view="venues"]')?.click();
  setTimeout(() => editVenue(id), 0);
}

let calendarModalEntryId = "";

function calendarEntryById(id) {
  return calendarDateEntries().find((entry) => entry.id === id);
}

function calendarColorForEntry(entry) {
  return entry.color || {
    application: "#a65b3e",
    result: "#7a55a2",
    event: "#087694",
    actual: "#16856c",
    other: "#c17832",
  }[entry.kind] || "#087694";
}

function closeCalendarEventModal() {
  const backdrop = document.getElementById("calendarEventBackdrop");
  if (!backdrop) return;
  backdrop.classList.remove("show");
  backdrop.setAttribute("aria-hidden", "true");
  calendarModalEntryId = "";
}

function openCalendarEventForm(date = "", event = null) {
  const backdrop = document.getElementById("calendarEventBackdrop");
  const form = document.getElementById("calendarEventForm");
  const detail = document.getElementById("calendarEventDetail");
  if (!backdrop || !form || !detail) return;
  calendarModalEntryId = event?.id || "";
  form.hidden = false;
  detail.hidden = true;
  document.getElementById("calendarEventModalTitle").textContent = event ? "予定を編集" : "予定を追加";
  form.elements.id.value = event?.id?.replace("custom:", "") || "";
  form.elements.type.value = event?.type || "other";
  form.elements.title.value = event?.title || "";
  form.elements.startDate.value = event?.startDate || date;
  form.elements.endDate.value = event?.endDate && event.endDate !== event.startDate ? event.endDate : "";
  form.elements.color.value = event?.color || "#087694";
  form.elements.memo.value = event?.memo || "";
  backdrop.classList.add("show");
  backdrop.setAttribute("aria-hidden", "false");
  setTimeout(() => form.elements.title.focus(), 80);
}

function openCalendarEntryDetail(entry) {
  const backdrop = document.getElementById("calendarEventBackdrop");
  const form = document.getElementById("calendarEventForm");
  const detail = document.getElementById("calendarEventDetail");
  if (!backdrop || !form || !detail || !entry) return;
  calendarModalEntryId = entry.id;
  form.hidden = true;
  detail.hidden = false;
  document.getElementById("calendarEventModalTitle").textContent = "予定の詳細";
  const dateText = entry.startDate === entry.endDate ? entry.startDate : `${entry.startDate} ～ ${entry.endDate}`;
  detail.innerHTML = `
    <div class="calendar-detail-accent" style="--event-color:${calendarColorForEntry(entry)}"></div>
    <span class="calendar-legend-item is-${entry.kind}">${escapeHtml(entry.label)}</span>
    <h4>${escapeHtml(entry.title)}</h4>
    <p class="calendar-detail-date">${escapeHtml(dateText)}</p>
    ${entry.venue ? `<p><strong>イベント</strong><br>${escapeHtml(eventLabel(entry.venue))}<br>${escapeHtml(entry.venue.placeName || "場所未設定")}</p>` : ""}
    ${entry.memo ? `<p class="calendar-detail-memo">${escapeHtml(entry.memo)}</p>` : '<p class="calendar-detail-memo">メモはありません。</p>'}
    <div class="form-actions">
      ${entry.system ? `<button class="primary-button" type="button" data-calendar-detail-venue="${entry.venue.id}">イベント記録を編集</button>` : `<button class="primary-button" type="button" data-calendar-detail-edit="${entry.id}">予定を編集</button><button class="danger-button" type="button" data-calendar-detail-delete="${entry.id}">予定を削除</button>`}
      <button class="ghost-button" type="button" data-calendar-detail-close>閉じる</button>
    </div>`;
  backdrop.classList.add("show");
  backdrop.setAttribute("aria-hidden", "false");
  detail.querySelector("[data-calendar-detail-venue]")?.addEventListener("click", () => {
    closeCalendarEventModal();
    openCalendarVenue(entry.venue.id);
  });
  detail.querySelector("[data-calendar-detail-edit]")?.addEventListener("click", () => openCalendarEventForm(entry.startDate, entry));
  detail.querySelector("[data-calendar-detail-delete]")?.addEventListener("click", () => deleteCalendarEvent(entry));
  detail.querySelector("[data-calendar-detail-close]")?.addEventListener("click", closeCalendarEventModal);
}

async function deleteCalendarEvent(entry) {
  const ok = await showConfirm("予定を削除しますか？", `${entry.title}をカレンダーから削除します。`);
  if (!ok) return;
  state.calendarEvents = state.calendarEvents.filter((event) => `custom:${event.id}` !== entry.id);
  if (!saveState()) return;
  closeCalendarEventModal();
  renderAll();
  showToast("予定を削除しました");
}

function bindCalendarModal() {
  const backdrop = document.getElementById("calendarEventBackdrop");
  const form = document.getElementById("calendarEventForm");
  if (!backdrop || !form) return;
  document.getElementById("closeCalendarEventModal")?.addEventListener("click", closeCalendarEventModal);
  document.getElementById("cancelCalendarEvent")?.addEventListener("click", closeCalendarEventModal);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeCalendarEventModal();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const startDate = data.get("startDate");
    const endDate = data.get("endDate") || startDate;
    if (!startDate || (endDate && endDate < startDate)) {
      showToast("終了日は開始日以降にしてください");
      return;
    }
    const next = normalizeCalendarEvent({
      id: data.get("id") || uid("calendar"),
      type: data.get("type"),
      title: data.get("title").trim(),
      startDate,
      endDate,
      color: data.get("color"),
      memo: data.get("memo").trim(),
    });
    upsert(state.calendarEvents, next);
    if (!saveState()) return;
    closeCalendarEventModal();
    renderAll();
    showToast("カレンダー予定を保存しました");
  });
}

function renderCalendar() {
  const calendar = document.getElementById("eventCalendar");
  const upcoming = document.getElementById("calendarUpcoming");
  const monthLabel = document.getElementById("calendarMonthLabel");
  if (!calendar || !upcoming || !monthLabel) return;

  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  monthLabel.textContent = `${year}年${month + 1}月`;
  const entries = calendarDateEntries();
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const gridStart = new Date(year, month, 1 - new Date(year, month, 1).getDay());
  const gridEnd = new Date(year, month + 1, 0);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));
  const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const dateFromKey = (key) => new Date(`${key}T00:00:00`);
  const weeks = [];
  for (let cursor = new Date(gridStart); cursor <= gridEnd; cursor.setDate(cursor.getDate() + 7)) {
    const weekStart = new Date(cursor);
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 6);
    let dayCells = "";
    for (let offset = 0; offset < 7; offset += 1) {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + offset);
      const key = dateKey(day);
      const pointEntries = entries.filter((entry) => entry.startDate === entry.endDate && entry.startDate === key);
      const rangeStarts = entries.filter((entry) => entry.startDate < entry.endDate && entry.startDate === key);
      const rangeEnds = entries.filter((entry) => entry.startDate < entry.endDate && entry.endDate === key);
      dayCells += `<div class="calendar-day${day.getMonth() !== month ? " is-outside" : ""}${key === todayKey ? " is-today" : ""}" data-calendar-date="${key}" role="button" tabindex="0" aria-label="${key}の予定">
        <button class="calendar-day-number" type="button" data-calendar-add-date="${key}" aria-label="${key}に予定を追加">${day.getDate()}</button>
        <div class="calendar-day-events">${pointEntries.map((entry) => `
          <button class="calendar-event is-${entry.kind}" type="button" data-calendar-entry="${entry.id}" style="--event-color:${calendarColorForEntry(entry)}" title="詳細を見る">
            <span>${escapeHtml(entry.label)}</span><b>${escapeHtml(entry.title)}</b>
          </button>`).join("")}</div>
        ${(rangeStarts.length || rangeEnds.length) ? `<div class="calendar-range-day-markers">
          ${rangeStarts.map((entry) => `<span class="is-start" title="${escapeHtml(entry.title)}の開始日">開始</span>`).join("")}
          ${rangeEnds.map((entry) => `<span class="is-end" title="${escapeHtml(entry.title)}の終了日">終了</span>`).join("")}
        </div>` : ""}
      </div>`;
    }
    const rangeEntries = entries.filter((entry) => entry.startDate < entry.endDate && entry.startDate <= dateKey(weekEnd) && entry.endDate >= dateKey(weekStart));
    const bars = rangeEntries.map((entry, rangeIndex) => {
      const segmentStart = Math.max(0, Math.floor((dateFromKey(entry.startDate) - weekStart) / 86400000));
      const segmentEnd = Math.min(6, Math.floor((dateFromKey(entry.endDate) - weekStart) / 86400000));
      const span = segmentEnd - segmentStart + 1;
      const segmentStartDate = new Date(weekStart);
      segmentStartDate.setDate(segmentStartDate.getDate() + segmentStart);
      const segmentEndDate = new Date(weekStart);
      segmentEndDate.setDate(segmentEndDate.getDate() + segmentEnd);
      const shortDate = (date) => `${date.getMonth() + 1}/${date.getDate()}`;
      const startLabel = entry.startDate === dateKey(segmentStartDate) ? `開始 ${shortDate(segmentStartDate)}` : "継続";
      const endLabel = entry.endDate === dateKey(segmentEndDate) ? `終了 ${shortDate(segmentEndDate)}` : "継続";
      const leftPercent = (segmentStart / 7) * 100;
      const widthPercent = (span / 7) * 100;
      const startsHere = entry.startDate === dateKey(segmentStartDate);
      const endsHere = entry.endDate === dateKey(segmentEndDate);
      return `<button class="calendar-range-event is-${entry.kind}${startsHere ? " is-range-start" : ""}${endsHere ? " is-range-end" : ""}" type="button" data-calendar-entry="${entry.id}" style="left:${leftPercent}%;width:${widthPercent}%;--range-row:${rangeIndex};--event-color:${calendarColorForEntry(entry)}" title="${escapeHtml(`${entry.title}：${entry.startDate} ～ ${entry.endDate}`)}"><span class="calendar-range-label"><em>${escapeHtml(startLabel)}</em><strong>${escapeHtml(entry.label)}：${escapeHtml(entry.title)}</strong><em>${escapeHtml(endLabel)}</em></span></button>`;
    }).join("");
    weeks.push(`<div class="calendar-week-row"><div class="calendar-week-days">${dayCells}${bars}</div></div>`);
  }
  calendar.innerHTML = `<div class="calendar-weekdays">${weekdays.map((day) => `<div class="calendar-weekday">${day}</div>`).join("")}</div><div class="calendar-weeks">${weeks.join("")}</div>`;
  const upcomingEntries = entries
    .filter((entry) => entry.date >= todayKey)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 12);
  upcoming.innerHTML = upcomingEntries.length ? upcomingEntries.map((entry) => `
    <button class="calendar-upcoming-item" type="button" data-calendar-upcoming="${entry.id}">
      <span class="calendar-upcoming-date">${escapeHtml(entry.startDate === entry.endDate ? entry.startDate : `${entry.startDate} ～ ${entry.endDate}`)}</span>
      <span class="calendar-legend-item is-${entry.kind}">${escapeHtml(entry.label)}</span>
      <strong>${escapeHtml(entry.title)}</strong>
      <small>${escapeHtml(entry.venue ? entry.venue.placeName || "場所未設定" : entry.memo || "詳細を見る")}</small>
    </button>`).join("") : `<p class="empty-state">イベントの予定日を登録すると、ここに表示されます。</p>`;
  upcoming.querySelectorAll("[data-calendar-upcoming]").forEach((button) => {
    button.addEventListener("click", () => openCalendarEntryDetail(calendarEntryById(button.dataset.calendarUpcoming)));
  });
}

function renderVenues() {
  const sort = document.getElementById("venueSort")?.value || "date";
  const venues = [...state.venues].sort((a, b) => sort === "name"
    ? eventLabel(a).localeCompare(eventLabel(b), "ja")
    : sort === "profit"
      ? eventSalesSummary(b.id).profit - eventSalesSummary(a.id).profit
      : (b.date || "").localeCompare(a.date || ""));
  const nodes = venues.map((venue) => {
    const summary = eventSalesSummary(venue.id);
    return `
      <article class="tile event-tile">
        <div class="gallery">
          ${(venue.images.length ? venue.images.slice(0, 3) : [""]).map((image, index) => (
            image ? `<img src="${image}" alt="${escapeHtml(venue.eventName)} ${index + 1}">` : `<div class="image-placeholder">画像</div>`
          )).join("")}
        </div>
        <h4>${escapeHtml(eventLabel(venue))}</h4>
        <p>${escapeHtml(venue.address || venue.memo || "イベントメモなし")}</p>
        <div class="event-summary">
          <div><span>売上</span><strong>${yen.format(summary.salesTotal)}</strong></div>
          <div><span>販売数</span><strong>${summary.quantityTotal}点</strong></div>
          <div><span>費用</span><strong>${yen.format(summary.expenseTotal)}</strong></div>
          <div><span>利益</span><strong class="${summary.profit < 0 ? "negative" : ""}">${yen.format(summary.profit)}</strong></div>
        </div>
        <div class="sold-breakdown">
          ${summary.items.length ? summary.items.map((item) => `<span>${escapeHtml(item.name)} ${item.quantity}点</span>`).join("") : "<span>販売記録なし</span>"}
        </div>
        <div class="prep-summary">
          <span>持参予定 ${toNumber(venue.plannedProductQty)}点</span>
          <span>釣り銭 ${yen.format(venue.cashFloat)}</span>
          <span>${escapeHtml(venue.prepItems || "持ち物未設定")}</span>
        </div>
        <div class="tile-meta">
          <span class="badge">${escapeHtml(venue.prefecture || "都道府県未設定")}</span>
          <span class="badge">${escapeHtml(venue.placeName)}</span>
          <span class="badge ${venue.status === "closed" ? "warn" : venue.status === "open" ? "good" : ""}">${venueStatusLabel(venue)}</span>
          <span class="badge good">画像 ${venue.images.length}枚</span>
        </div>
        <div class="tile-actions">
          ${venue.status === "closed"
            ? `<button class="ghost-button" data-reopen-venue="${venue.id}">販売を再開</button>`
            : `<button class="primary-button" data-open-venue="${venue.id}">${venue.status === "open" ? "販売中" : "販売を開始"}</button>`}
          <button class="ghost-button" data-select-workflow-venue="${venue.id}">進行を確認</button>
          <button class="ghost-button" data-edit-venue="${venue.id}">編集</button>
          <button class="danger-button" data-delete-venue="${venue.id}">削除</button>
        </div>
      </article>`;
  });
  fillList("venueList", nodes, "出展イベントを登録してください");
  bindListActions();
}

function venueStatusLabel(venue) {
  return venue.status === "closed" ? "締め済み" : venue.status === "open" ? "販売中" : "準備中";
}

function keepVenueListIndependent() {
  const list = document.getElementById("venueList");
  if (!list) return;
  list.querySelectorAll("[data-open-venue], [data-reopen-venue], [data-select-workflow-venue]")
    .forEach((button) => button.remove());
  list.querySelectorAll(".event-tile .badge").forEach((badge) => {
    if (badge.textContent.trim() === "販売中") badge.textContent = "出展中";
  });
}

function eventCashSummary(venueId) {
  const sales = state.sales.filter((sale) => saleIsActive(sale) && sale.venueId === venueId);
  return sales.reduce((summary, sale) => {
    if (sale.paymentMethod === "cashless") summary.cashless += toNumber(sale.total);
    else summary.cash += toNumber(sale.total);
    return summary;
  }, { cash: 0, cashless: 0 });
}

function renderEventWorkflow() {
  const select = document.getElementById("eventWorkflowEvent");
  const summaryNode = document.getElementById("eventWorkflowSummary");
  const form = document.getElementById("eventSettlementForm");
  if (!select || !summaryNode || !form) return;
  const current = select.value;
  const venues = [...state.venues].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  select.innerHTML = optionList(venues, "イベントを登録してください", eventLabel);
  if (venues.some((venue) => venue.id === current)) select.value = current;
  const venue = venues.find((entry) => entry.id === select.value) || venues[0];
  if (!venue) {
    summaryNode.innerHTML = '<div class="empty-note">まずイベントを登録し、持参予定数と釣り銭を入力してください。</div>';
    form.hidden = true;
    return;
  }
  select.value = venue.id;
  form.hidden = false;
  const cash = eventCashSummary(venue.id);
  const expectedCash = toNumber(venue.cashFloat) + cash.cash;
  const settlement = venue.settlement;
  summaryNode.innerHTML = `
    <div class="workflow-status"><span class="badge ${venue.status === "closed" ? "warn" : venue.status === "open" ? "good" : ""}">${venueStatusLabel(venue)}</span><strong>${escapeHtml(eventLabel(venue))}</strong></div>
    <p>${escapeHtml(venue.placeName)} / ${escapeHtml(venue.date || "日付未設定")}</p>
    <div class="workflow-metrics">
      <div><span>準備する商品</span><strong>${toNumber(venue.plannedProductQty)}点</strong></div>
      <div><span>開始時の釣り銭</span><strong>${yen.format(venue.cashFloat)}</strong></div>
      <div><span>現金売上</span><strong>${yen.format(cash.cash)}</strong></div>
      <div><span>キャッシュレス</span><strong>${yen.format(cash.cashless)}</strong></div>
      <div><span>締め時の期待現金</span><strong>${yen.format(expectedCash)}</strong></div>
    </div>
    ${settlement ? `<p class="settlement-result">前回締め：現金差額 ${yen.format(settlement.cashDifference || 0)} / キャッシュレス差額 ${yen.format(settlement.cashlessDifference || 0)}</p>` : ""}`;
  form.elements.actualCash.value = settlement ? settlement.actualCash : expectedCash;
  form.elements.actualCashless.value = settlement ? settlement.actualCashless : cash.cashless;
  form.elements.closingNote.value = settlement?.note || "";
  const actualCash = toNumber(form.elements.actualCash.value);
  const actualCashless = toNumber(form.elements.actualCashless.value);
  document.getElementById("eventSettlementPreview").innerHTML = `期待現金 ${yen.format(expectedCash)} → 差額 <strong class="${actualCash - expectedCash < 0 ? "negative" : ""}">${yen.format(actualCash - expectedCash)}</strong> / キャッシュレス差額 ${yen.format(actualCashless - cash.cashless)}`;
}

function updateVenueStatus(id, status) {
  const venue = state.venues.find((entry) => entry.id === id);
  if (!venue) return;
  venue.status = status;
  if (status === "open") {
    venue.openedAt = venue.openedAt || new Date().toISOString();
    venue.closedAt = "";
  }
  if (status === "planned") venue.closedAt = "";
  if (!saveState({ action: status === "open" ? "イベント販売開始" : "イベント販売再開" })) return;
  renderAll();
  showToast(status === "open" ? "イベントの販売を開始しました" : "イベントの販売を再開しました");
}

async function saveEventSettlement(event) {
  event.preventDefault();
  const venueId = document.getElementById("eventWorkflowEvent")?.value;
  const venue = state.venues.find((entry) => entry.id === venueId);
  if (!venue) return;
  const form = event.currentTarget;
  const cash = eventCashSummary(venue.id);
  const expectedCash = toNumber(venue.cashFloat) + cash.cash;
  const actualCash = Math.max(0, toNumber(form.elements.actualCash.value));
  const actualCashless = Math.max(0, toNumber(form.elements.actualCashless.value));
  venue.status = "closed";
  venue.closedAt = new Date().toISOString();
  venue.settlement = {
    expectedCash,
    actualCash,
    cashDifference: actualCash - expectedCash,
    recordedCashless: cash.cashless,
    actualCashless,
    cashlessDifference: actualCashless - cash.cashless,
    note: form.elements.closingNote.value.trim(),
    closedAt: venue.closedAt,
  };
  if (!saveState({ action: "イベント締め処理" })) return;
  renderAll();
  showToast("イベントの締め処理を保存しました");
}

function renderPurchaseOptions() {
  const partOptions = optionList(state.parts, "部品を選択してください");
  document.querySelectorAll("#purchaseLines .purchase-batch-part").forEach((select) => {
    const current = pendingPurchasePartId || select.value;
    select.innerHTML = partOptions;
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  });
  const supplierSelect = document.getElementById("purchaseSupplier");
  if (supplierSelect) {
    const currentSupplier = supplierSelect.value;
    const suppliers = state.masters?.suppliers || [];
    supplierSelect.innerHTML = `<option value="">仕入先を選択してください</option>${suppliers.map((supplier) => `<option value="${escapeHtml(supplier.name)}">${escapeHtml(supplier.name)}</option>`).join("")}`;
    if ([...supplierSelect.options].some((option) => option.value === currentSupplier)) supplierSelect.value = currentSupplier;
  }
  pendingPurchasePartId = "";
}

function addPurchaseLine({ partId = "", qty = "1", unitCost = "0" } = {}) {
  const container = document.getElementById("purchaseLines");
  if (!container) return null;
  const line = document.createElement("div");
  line.className = "purchase-batch-line";
  line.dataset.purchaseLine = "";
  line.dataset.mode = "existing";
  line.classList.add("is-existing");
  line.innerHTML = `
    <div class="purchase-line-mode" role="group" aria-label="部品の登録方法">
      <button class="purchase-mode-button active" type="button" data-purchase-mode="existing">既存部品</button>
      <button class="purchase-mode-button" type="button" data-purchase-mode="new">新規部品</button>
    </div>
    <label class="purchase-existing-field">部品<select class="purchase-batch-part" name="batchPartId" required></select></label>
    <label class="purchase-new-field" hidden>新しい部品名<input name="batchPartName" type="text" maxlength="80" placeholder="例：クリアビーズ 8mm" /></label>
    <label>数量<div class="purchase-quantity-control"><button type="button" data-purchase-qty-step="-1" aria-label="数量を1減らす">−</button><input name="batchQty" type="number" min="0.01" step="0.01" value="${escapeHtml(qty)}" required /><button type="button" data-purchase-qty-step="1" aria-label="数量を1増やす">＋</button></div></label>
    <label>仕入単価<input name="batchUnitCost" type="number" min="0" step="1" value="${escapeHtml(unitCost)}" required /></label>
    <button class="icon-button purchase-line-remove" type="button" data-remove-purchase-line aria-label="この部品行を削除" title="この部品行を削除">×</button>
  `;
  container.appendChild(line);
  renderPurchaseOptions();
  const select = line.querySelector(".purchase-batch-part");
  if (select) select.value = partId;
  return line;
}

function setPurchaseLineMode(line, mode = "existing") {
  if (!line) return;
  const isNew = mode === "new";
  line.dataset.mode = isNew ? "new" : "existing";
  line.classList.toggle("is-new", isNew);
  line.classList.toggle("is-existing", !isNew);
  line.querySelectorAll("[data-purchase-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.purchaseMode === line.dataset.mode);
  });
  const existingField = line.querySelector(".purchase-existing-field");
  const newField = line.querySelector(".purchase-new-field");
  const existingSelect = line.querySelector("[name=batchPartId]");
  const newInput = line.querySelector("[name=batchPartName]");
  if (existingField) existingField.hidden = isNew;
  if (newField) newField.hidden = !isNew;
  if (existingSelect) existingSelect.required = !isNew;
  if (newInput) newInput.required = isNew;
  if (isNew) newInput?.focus();
}

function renderPurchases() {
  renderPurchaseOptions();
  const node = document.getElementById("purchaseList");
  if (!node) return;
  const query = (document.getElementById("purchaseSearch")?.value || "").trim().toLowerCase();
  const grouped = new Map();
  state.parts.forEach((part) => {
    (part.purchases || []).forEach((purchase) => {
      const key = purchase.batchId || purchase.id;
      if (!grouped.has(key)) grouped.set(key, {
        key,
        batchId: purchase.batchId || "",
        date: purchase.date || "",
        supplier: purchase.supplier || "",
        memo: purchase.memo || "",
        items: [],
      });
      grouped.get(key).items.push({ part, purchase });
    });
  });
  const rows = [...grouped.values()].filter((group) => {
    if (!query) return true;
    const text = `${group.supplier} ${group.memo} ${group.items.map(({ part }) => part.name).join(" ")}`.toLowerCase();
    return text.includes(query);
  });
  const sort = document.getElementById("purchaseSort")?.value || "date";
  rows.sort((a, b) => sort === "amount"
    ? b.items.reduce((sum, item) => sum + toNumber(item.purchase.total), 0) - a.items.reduce((sum, item) => sum + toNumber(item.purchase.total), 0)
    : sort === "name"
      ? a.items[0].part.name.localeCompare(b.items[0].part.name, "ja")
      : String(b.date).localeCompare(String(a.date)));
  node.innerHTML = rows.length ? rows.map((group) => {
    const isBatch = Boolean(group.batchId) || group.items.length > 1;
    const amount = group.items.reduce((sum, item) => sum + toNumber(item.purchase.total), 0);
    const itemText = group.items.map(({ part, purchase }) => `
      <div class="purchase-history-line">
        <span><strong>${escapeHtml(part.name)}</strong> ${purchase.qty}${escapeHtml(part.unit)} × ${yen.format(purchase.unitCost)}</span>
        <span>${yen.format(purchase.total)}</span>
        <span class="purchase-history-line-actions"><button class="ghost-button" data-edit-purchase="${purchase.id}" data-purchase-part="${part.id}">編集</button><button class="danger-button" data-delete-purchase="${purchase.id}" data-purchase-part="${part.id}">削除</button></span>
      </div>
    `).join("");
    return `<article class="row-item purchase-history-item">
      <div>
        <h4>${escapeHtml(`${group.date || "日付未設定"} / ${group.supplier || "仕入先未設定"}`)}</h4>
        <div class="purchase-history-meta"><span class="purchase-history-badge ${isBatch ? "is-batch" : "is-single"}">${isBatch ? `まとめ仕入（${group.items.length}品目）` : "単一仕入"}</span><strong>合計 ${yen.format(amount)}</strong>${group.memo ? `<span>${escapeHtml(group.memo)}</span>` : ""}</div>
        <div class="purchase-history-lines">${itemText}</div>
      </div>
      <div class="tile-actions"><span class="badge good">在庫に反映済み</span></div>
    </article>`;
  }).join("") : '<div class="empty-note">仕入れ履歴はまだありません</div>';
  node.querySelectorAll("[data-edit-purchase]").forEach((button) => button.addEventListener("click", () => editPurchase(button.dataset.purchasePart, button.dataset.editPurchase)));
  node.querySelectorAll("[data-delete-purchase]").forEach((button) => button.addEventListener("click", () => deletePurchase(button.dataset.purchasePart, button.dataset.deletePurchase)));
}

function editPurchase(partId, purchaseId) {
  const part = state.parts.find((entry) => entry.id === partId);
  const purchase = part?.purchases?.find((entry) => entry.id === purchaseId);
  if (!part || !purchase) return;
  document.querySelector('.nav-item[data-view="purchases"]')?.click();
  setSectionTab("purchases", "edit");
  const form = document.getElementById("purchaseForm");
  form.elements.id.value = purchase.id;
  form.elements.originalPartId.value = part.id;
  form.elements.date.value = purchase.date || "";
  form.elements.supplier.value = purchase.supplier || part.supplier || "";
  form.elements.memo.value = purchase.memo || "";
  const lines = document.getElementById("purchaseLines");
  if (lines) {
    lines.innerHTML = "";
    addPurchaseLine({ partId: part.id, qty: purchase.qty, unitCost: purchase.unitCost });
  }
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function addVenueDrawerCloseButton() {
  const drawer = document.getElementById("venueEditorDrawer");
  const header = drawer?.querySelector(".panel-header");
  if (!header || header.querySelector(".drawer-close")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button drawer-close";
  button.setAttribute("aria-label", "閉じる");
  button.textContent = "×";
  header.appendChild(button);
}

function openVenueEditor() {
  const drawer = document.getElementById("venueEditorDrawer");
  if (!drawer) return;
  addVenueDrawerCloseButton();
  updateVenueRecordMode();
  setVenueTab("basic");
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  setTimeout(() => drawer.querySelector('[name="eventName"]')?.focus(), 80);
}

function updateVenueRecordMode() {
  const form = document.getElementById("venueForm");
  const tab = document.querySelector('[data-event-page-tab="record"]');
  const mode = form?.elements.id.value ? "編集" : "新規";
  if (tab) tab.textContent = `記録（${mode}）`;
  const title = document.getElementById("venueRecordMode");
  if (title) title.textContent = mode;
}

function closeVenueEditor() {
  const drawer = document.getElementById("venueEditorDrawer");
  if (!drawer) return;
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
}

function setupVenuePageTabs() {
  const listView = document.querySelector(".event-list-view");
  const drawer = document.getElementById("venueEditorDrawer");
  if (listView && drawer && !document.querySelector(".event-record-view")) {
    const recordView = document.createElement("div");
    recordView.className = "event-record-view";
    listView.after(recordView);
    recordView.appendChild(drawer);
  }
  document.querySelectorAll("[data-event-page-tab]").forEach((button) => {
    button.addEventListener("click", () => setVenuePageTab(button.dataset.eventPageTab));
  });
  setVenuePageTab("list");
}

function setVenuePageTab(id) {
  document.querySelectorAll("[data-event-page-tab]").forEach((tab) => {
    const active = tab.dataset.eventPageTab === id;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  const workflow = document.getElementById("eventWorkflowPanel");
  workflow?.classList.toggle("is-active", id === "progress");
  const list = document.querySelector(".event-list-view");
  list?.classList.toggle("is-hidden", id !== "list");
  const record = document.querySelector(".event-record-view");
  record?.classList.toggle("is-active", id === "record");
  if (id === "record") {
    const form = document.getElementById("venueForm");
    if (form && !form.elements.id.value) clearVenueForm();
    updateVenueRecordMode();
    openVenueEditor();
  }
  if (id === "progress") closeVenueEditor();
}

function renderVenueDaySalesSummary() {
  const node = document.getElementById("venueDaySalesSummary");
  const form = document.getElementById("venueForm");
  if (!node || !form) return;
  const venueId = form.elements.id.value;
  if (!venueId) {
    node.innerHTML = `
      <div class="venue-day-sales-heading">
        <div><p class="eyebrow">SALES RECORD</p><h4>当日の販売記録</h4><p>イベントを保存すると、このイベント専用のレジを開けます。</p></div>
        <button class="primary-button" type="button" disabled>イベント保存後にレジを開けます</button>
      </div>
    `;
    return;
  }
  const summary = eventSalesSummary(venueId);
  const rows = summary.items?.length
    ? summary.items.map((item) => `<div class="venue-sale-summary-row"><span>${escapeHtml(item.name)}</span><strong>${item.quantity}個</strong></div>`).join("")
    : '<p class="field-help">まだ販売記録がありません。レジまたは販売履歴から登録できます。</p>';
  node.innerHTML = `
    <div class="venue-day-sales-heading">
      <div><p class="eyebrow">SALES RECORD</p><h4>当日の販売記録</h4><p>このイベントに紐づく商品別の販売数です。</p></div>
      <button class="primary-button" id="openVenueRegisterFromDay" type="button">このイベントのレジを開く</button>
    </div>
    <div class="venue-sale-summary-list">${rows}</div>
  `;
  node.querySelector("#openVenueRegisterFromDay")?.addEventListener("click", () => {
    const registerEvent = document.getElementById("registerEvent");
    if (registerEvent) registerEvent.value = venueId;
    document.querySelector('.nav-item[data-view="register"]')?.click();
    setRegisterDefaultTime();
    renderRegisterTotals();
  });
}

function setupVenueEditorTabs() {
  const form = document.getElementById("venueForm");
  if (!form || form.querySelector(".venue-tabs")) return;
  const header = form.querySelector(".panel-header");
  const tabNav = document.createElement("div");
  tabNav.className = "venue-tabs";
  tabNav.setAttribute("role", "tablist");
  const tabs = [
    ["reflection", "振り返り"],
    ["basic", "基本情報"],
    ["prep", "準備"],
    ["day", "持ち物・当日"],
    ["closing", "締め"],
  ];
  const reflectionTab = tabs.shift();
  tabs.splice(3, 0, reflectionTab);
  tabs.forEach(([id, label], index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `venue-tab${index === 0 ? " active" : ""}`;
    button.dataset.venueTab = id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", index === 0 ? "true" : "false");
    button.textContent = label;
    button.addEventListener("click", () => setVenueTab(id));
    tabNav.appendChild(button);
  });
  const tabLabels = { basic: "基本情報", prep: "準備チェック", day: "当日記録", reflection: "振り返り", closing: "締め" };
  tabNav.querySelectorAll("[data-venue-tab]").forEach((button) => {
    button.textContent = tabLabels[button.dataset.venueTab] || button.textContent;
  });
  header?.after(tabNav);

  const panels = Object.fromEntries(tabs.map(([id]) => {
    const panel = document.createElement("section");
    panel.className = `venue-tab-panel${id === "basic" ? " active" : ""}`;
    panel.dataset.venuePanel = id;
    panel.setAttribute("role", "tabpanel");
    return [id, panel];
  }));
  tabNav.after(...Object.values(panels));

  [...form.children].forEach((child) => {
    if (child === header || child === tabNav || Object.values(panels).includes(child)
      || child.matches('input[type="hidden"]') || child.matches(".form-actions, .field-help")) return;
    const panel = child.classList.contains("prep-box") ? panels.prep
      : child.classList.contains("event-record-box") ? panels.day
        : panels.basic;
    panel.appendChild(child);
  });

  const recordBox = panels.day.querySelector(".event-record-box");
  if (recordBox) {
    const fixtures = recordBox.querySelector('label:has([name="fixtures"])');
    const review = recordBox.querySelector('label:has([name="review"])');
    const customNotes = recordBox.querySelector('label:has([name="customNotes"])');
    if (fixtures) panels.prep.appendChild(fixtures);
    panels.reflection.innerHTML = `
      <div class="venue-reflection-heading">
        <p class="eyebrow">AFTER EVENT</p>
        <h4>出展を振り返る</h4>
        <p>売れた商品、来場者の反応、次回改善したいことを残します。</p>
      </div>
    `;
    if (review) panels.reflection.appendChild(review);
    if (customNotes) panels.reflection.appendChild(customNotes);
  }

  const daySales = document.createElement("section");
  daySales.className = "venue-day-sales";
  daySales.id = "venueDaySalesSummary";
  panels.day.appendChild(daySales);
  renderVenueDaySalesSummary();

  panels.closing.innerHTML = `
    <div class="venue-closing-guide">
      <p class="eyebrow">EVENT CLOSING</p>
      <h4>販売結果と費用を締めます</h4>
      <p>イベント終了後の売上、現金、キャッシュレス、費用を確認して締め処理を行います。</p>
      <button class="primary-button" id="openVenueClosing" type="button">締め処理を開く</button>
    </div>
  `;
  panels.closing.querySelector("#openVenueClosing").addEventListener("click", () => {
    const id = form.elements.id.value;
    if (!id) {
      showToast("イベントを保存してから締め処理を開いてください");
      setVenueTab("basic");
      return;
    }
    closeVenueEditor();
    setVenuePageTab("progress");
    const workflow = document.getElementById("eventWorkflowEvent");
    if (workflow && id) {
      workflow.value = id;
      renderEventWorkflow();
    }
    document.getElementById("eventWorkflowPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function setVenueTab(id) {
  document.querySelectorAll("[data-venue-tab]").forEach((tab) => {
    const active = tab.dataset.venueTab === id;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-venue-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.venuePanel === id);
  });
  if (id === "day") renderVenueDaySalesSummary();
}

function setupVenueChecklist() {
  const form = document.getElementById("venueForm");
  const textarea = form?.elements.prepItems;
  const fieldset = form?.querySelector(".prep-box");
  if (!textarea || !fieldset || fieldset.querySelector(".prep-checklist")) return;
  const label = textarea.closest("label");
  const list = document.createElement("div");
  list.className = "prep-checklist";
  list.id = "prepChecklist";
  const progress = document.createElement("div");
  progress.className = "prep-progress";
  progress.id = "prepProgress";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-button checklist-sync";
  button.textContent = "入力内容をチェックリストに反映";
  button.addEventListener("click", () => renderPrepChecklist(parsePrepItems(textarea.value)));
  list.addEventListener("change", updatePrepChecklistProgress);
  label?.after(progress, list, button);
  textarea.addEventListener("change", () => renderPrepChecklist(parsePrepItems(textarea.value)));
}

function parsePrepItems(value = "") {
  return String(value).split(/[\n,、]/).map((label) => label.trim()).filter(Boolean)
    .map((label) => ({ label, checked: false }));
}

function renderPrepChecklist(items = []) {
  const list = document.getElementById("prepChecklist");
  if (!list) return;
  list.replaceChildren();
  if (!items.length) {
    list.innerHTML = '<p class="field-help">準備するものを改行または「、」区切りで入力し、反映ボタンを押してください。</p>';
    updatePrepChecklistProgress();
    return;
  }
  items.forEach((item) => {
    const label = document.createElement("label");
    label.className = "check-label prep-check-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(item.checked);
    checkbox.dataset.prepLabel = item.label;
    label.append(checkbox, document.createTextNode(item.label));
    list.appendChild(label);
  });
  updatePrepChecklistProgress();
}

function updatePrepChecklistProgress() {
  const list = document.getElementById("prepChecklist");
  const progress = document.getElementById("prepProgress");
  if (!list || !progress) return;
  const checks = [...list.querySelectorAll('input[type="checkbox"]')];
  const done = checks.filter((checkbox) => checkbox.checked).length;
  const total = checks.length;
  progress.innerHTML = `<strong>準備チェック</strong><span>${done} / ${total} 完了</span><i><b style="width:${total ? Math.round((done / total) * 100) : 0}%"></b></i>`;
}

function readPrepChecklist() {
  return [...document.querySelectorAll("#prepChecklist input[type=checkbox]")]
    .map((checkbox) => ({ label: checkbox.dataset.prepLabel || "", checked: checkbox.checked }))
    .filter((item) => item.label);
}

function renderVenueCarryRows(rows = []) {
  const container = document.getElementById("venueCarryRows");
  if (!container) return;
  container.replaceChildren();
  const source = rows.length ? rows : [{ productId: "", quantity: 0 }];
  source.forEach((row) => addVenueCarryRow(row.productId, row.quantity));
}

function addVenueCarryRow(productId = "", quantity = 0) {
  const container = document.getElementById("venueCarryRows");
  if (!container) return;
  const row = document.createElement("div");
  row.className = "venue-carry-row";
  row.innerHTML = `
    <select name="carriedProductId" aria-label="持参商品">
      <option value="">商品を選択</option>
      ${state.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`).join("")}
    </select>
    <input name="carriedProductQty" type="number" min="0" step="1" value="${Math.max(0, Math.floor(toNumber(quantity)))}" aria-label="持参数量" />
    <button class="icon-button venue-carry-remove" type="button" aria-label="商品行を削除">×</button>
  `;
  row.querySelector("select").value = productId || "";
  row.querySelector(".venue-carry-remove").addEventListener("click", () => {
    row.remove();
    if (!container.children.length) addVenueCarryRow();
  });
  container.appendChild(row);
}

function readVenueCarryRows() {
  return [...document.querySelectorAll("#venueCarryRows .venue-carry-row")]
    .map((row) => ({
      productId: row.querySelector('[name="carriedProductId"]')?.value || "",
      quantity: Math.floor(toNumber(row.querySelector('[name="carriedProductQty"]')?.value)),
    }))
    .filter((row) => row.productId && row.quantity > 0);
}

function renderVenuePlanRows(rows = []) {
  const container = document.getElementById("venuePlanRows");
  if (!container) return;
  container.replaceChildren();
  const source = rows.length ? rows : [{ productId: "", quantity: 0 }];
  source.forEach((row) => addVenuePlanRow(row.productId, row.quantity));
}

function addVenuePlanRow(productId = "", quantity = 0) {
  const container = document.getElementById("venuePlanRows");
  if (!container) return;
  const row = document.createElement("div");
  row.className = "venue-carry-row";
  row.innerHTML = `
    <select name="plannedProductId" aria-label="持込み予定商品">
      <option value="">商品を選択</option>
      ${state.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`).join("")}
    </select>
    <input name="plannedProductQtyRow" type="number" min="0" step="1" value="${Math.max(0, Math.floor(toNumber(quantity)))}" aria-label="持込み予定数量" />
    <button class="icon-button venue-carry-remove" type="button" aria-label="商品行を削除">×</button>
  `;
  row.querySelector("select").value = productId || "";
  row.querySelector(".venue-carry-remove").addEventListener("click", () => {
    row.remove();
    if (!container.children.length) addVenuePlanRow();
  });
  container.appendChild(row);
}

function readVenuePlanRows() {
  return [...document.querySelectorAll("#venuePlanRows .venue-carry-row")]
    .map((row) => ({
      productId: row.querySelector('[name="plannedProductId"]')?.value || "",
      quantity: Math.floor(toNumber(row.querySelector('[name="plannedProductQtyRow"]')?.value)),
    }))
    .filter((row) => row.productId && row.quantity > 0);
}

async function deletePurchase(partId, purchaseId) {
  const part = state.parts.find((entry) => entry.id === partId);
  const index = part?.purchases?.findIndex((entry) => entry.id === purchaseId) ?? -1;
  if (!part || index < 0) return;
  const purchase = part.purchases[index];
  if (toNumber(part.stock) < toNumber(purchase.qty)) {
    showToast("この仕入履歴は現在庫より多く、削除できません。先に棚卸しで在庫を確認してください。");
    return;
  }
  const ok = await showConfirm("仕入れ履歴を削除しますか？", `${part.name}の入荷${purchase.qty}${part.unit}を削除し、在庫から差し引きます。`);
  if (!ok) return;
  part.purchases.splice(index, 1);
  part.stock = Math.max(0, toNumber(part.stock) - toNumber(purchase.qty));
  recalculatePartCost(part);
  if (!saveState({ action: "仕入れ履歴削除" })) return;
  renderAll();
  showToast("仕入れ履歴を削除しました");
}

function renderStockHistory() {
  const node = document.getElementById("stockHistoryList");
  if (!node) return;
  const typeFilter = document.getElementById("stockHistoryType")?.value || "";
  const query = (document.getElementById("stockHistorySearch")?.value || "").trim().toLowerCase();
  const rows = [];
  state.parts.forEach((part) => (part.purchases || []).forEach((purchase) => rows.push({
    date: purchase.date,
    type: "purchase",
    label: part.name,
    detail: `仕入れ +${purchase.qty}${part.unit} / ${purchase.supplier || "仕入先未設定"} / ${yen.format(purchase.total)}`,
  })));
  state.sales.forEach((sale) => rows.push({
    date: sale.date,
    type: "sale",
    label: sale.itemName,
    detail: `販売 -${sale.quantity}点 / ${yen.format(sale.total)} / ${saleVenueName(sale)}`,
  }));
  state.products.forEach((product) => (product.productions || []).forEach((record) => rows.push({
    date: record.date,
    type: "production",
    label: product.name,
    detail: `製作 +${record.quantity}点 / 原価 ${yen.format(record.totalCost)}`,
  })));
  (state.stockAdjustments || []).forEach((entry) => rows.push({
    date: entry.at,
    type: "adjustment",
    label: entry.itemName,
    detail: `棚卸し ${entry.before} → ${entry.after} / ${entry.reason}`,
  }));
  const filtered = rows
    .filter((row) => !typeFilter || row.type === typeFilter)
    .filter((row) => !query || `${row.label} ${row.detail}`.toLowerCase().includes(query))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, 200);
  const typeLabel = { purchase: "仕入れ", sale: "販売", production: "製作", adjustment: "棚卸し" };
  node.innerHTML = filtered.length ? filtered.map((row) => rowItem(
    `${row.date || "日付未設定"} / ${row.label}`,
    row.detail,
    `<span class="badge ${row.type === "sale" ? "warn" : row.type === "adjustment" ? "" : "good"}">${typeLabel[row.type]}</span>`,
  )).join("") : '<div class="empty-note">該当する在庫移動はありません</div>';
}

function renderProductionOptions() {
  const select = document.getElementById("productionProduct");
  const current = select.value;
  select.innerHTML = optionList(state.products, "商品なし");
  if (state.products.some((product) => product.id === current)) select.value = current;
  renderProductionPreview();
}

function renderProductionPreviewLegacy() {
  const product = state.products.find((entry) => entry.id === document.getElementById("productionProduct").value);
  const quantity = Math.floor(toNumber(document.querySelector("#productionForm [name=quantity]").value));
  const preview = document.getElementById("productionPreview");
  if (!product) {
    preview.className = "production-preview empty-note";
    preview.textContent = "商品を選択してください";
    return;
  }
  if (!product.recipe.length) {
    preview.className = "production-preview empty-note";
    preview.textContent = "この商品には使用部品が設定されていません";
    return;
  }

  const rows = product.recipe.map((row) => {
    const part = state.parts.find((entry) => entry.id === row.partId);
    const required = toNumber(row.qty) * Math.max(quantity, 0);
    const stock = toNumber(part?.stock);
    const unit = part?.unit || "";
    const short = stock < required;
    return `<li class="${short ? "short" : ""}">${escapeHtml(part?.name || "削除済み部品")} ${required}${escapeHtml(unit)} / 在庫 ${stock}${escapeHtml(unit)}</li>`;
  });
  const unitCost = recipeCost(product);
  const totalCost = unitCost * Math.max(quantity, 0);
  preview.className = `production-preview ${productionShortage(product, quantity).length ? "has-shortage" : ""}`;
  preview.innerHTML = `
    <div class="production-cost-preview">
      <span>今回原価</span>
      <strong>${yen.format(unitCost)} / 点</strong>
      <em>${Math.max(quantity, 0)}点で ${yen.format(totalCost)}</em>
    </div>
    <ul>${rows.join("")}</ul>
  `;
}

function renderSaleOptions() {
  const venueOptions = optionList(state.venues, "出展イベントなし", eventLabel);
  document.getElementById("saleVenue").innerHTML = `<option value="">未設定</option>${venueOptions}`;

  const type = document.getElementById("saleItemType").value;
  const items = type === "product" ? state.products : state.parts;
  document.getElementById("saleItem").innerHTML = optionList(items, "品目なし");
  fillSalePrice();
}

function renderRegisterOptions() {
  const eventSelect = document.getElementById("registerEvent");
  const currentEvent = eventSelect.value;
  const venues = [...state.venues].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  eventSelect.innerHTML = optionList(venues, "イベントなし", (venue) => `${eventLabel(venue)} / ${venueStatusLabel(venue)}`);
  if (venues.some((venue) => venue.id === currentEvent)) eventSelect.value = currentEvent;
  else if (venues[0]) eventSelect.value = venues[0].id;

  const type = document.getElementById("registerItemType").value || "product";
  renderRegisterCategoryTabs();
  const items = type === "product"
    ? state.products.filter((item) => !selectedRegisterCategory || item.category === selectedRegisterCategory)
    : state.parts;
  if (selectedRegisterItem?.itemType !== type) {
    selectedRegisterItem = null;
    document.getElementById("registerItem").value = "";
  }
  renderSelectedRegisterItem();
  renderRegisterItemButtons(items, type);
  setRegisterDefaultTime();
  renderRegisterTotals();
}

function renderRegisterCategoryTabs() {
  const container = document.querySelector("#register [class=register-tabs]");
  if (!container) return;
  const categories = [...new Set(state.products.map((product) => product.category).filter(Boolean))];
  const tabs = [
    { type: "product", category: "", label: "すべて" },
    ...categories.map((category) => ({ type: "product", category, label: category })),
    { type: "part", category: "", label: "部品" },
  ];
  container.innerHTML = tabs.map((tab) => {
    const active = tab.type === "part"
      ? document.getElementById("registerItemType").value === "part"
      : document.getElementById("registerItemType").value === "product" && selectedRegisterCategory === tab.category;
    return `<button class="register-tab${active ? " active" : ""}" type="button" data-register-type="${tab.type}" data-register-category="${escapeHtml(tab.category)}">${escapeHtml(tab.label)}</button>`;
  }).join("");
  container.querySelectorAll("[data-register-type]").forEach((button) => {
    button.onclick = () => {
      if (button.dataset.registerType === "part") {
        selectedRegisterCategory = "";
        setRegisterType("part");
      } else {
        selectedRegisterCategory = button.dataset.registerCategory || "";
        setRegisterType("product");
      }
    };
  });
}

function renderRegisterItemButtons(items, type) {
  const container = document.getElementById("registerItemButtons");
  if (!container) return;
  container.innerHTML = items.length ? items.map((item) => {
    const price = type === "product" ? toNumber(item.price) : toNumber(item.cost);
    const selected = selectedRegisterItem?.itemType === type && selectedRegisterItem?.itemId === item.id;
    return `
      <button type="button" class="register-product-card${selected ? " selected" : ""}" data-register-item-type="${type}" data-register-item-id="${item.id}">
        ${imageOrPlaceholder(item.image, item.name, "register-product-image")}
        <span>${escapeHtml(item.name)}</span>
        <strong>${yen.format(price)}</strong>
        <em>在庫 ${item.stock ?? 0}</em>
        <i aria-hidden="true">＋</i>
      </button>
    `;
  }).join("") : '<div class="empty-note">登録された商品がありません</div>';
  container.querySelectorAll("[data-register-item-id]").forEach((button) => {
    button.onclick = () => {
      selectRegisterItem(button.dataset.registerItemType, button.dataset.registerItemId);
      addRegisterLine();
    };
  });
}

function setRegisterType(type) {
  document.getElementById("registerItemType").value = type;
  if (type === "part") selectedRegisterCategory = "";
  document.querySelectorAll("[data-register-type]").forEach((button) => {
    button.classList.toggle("active", button.dataset.registerType === type);
  });
  renderRegisterOptions();
}

function setRegisterPaymentMethod(method) {
  const select = document.getElementById("registerPaymentMethod");
  if (!select) return;
  select.value = method === "cashless" ? "cashless" : "cash";
  renderRegisterTotals();
}

function setRegisterScreen(screen) {
  const target = document.querySelector(`[data-register-screen="${screen}"]`);
  if (!target) return;
  if (["payment", "amount"].includes(screen) && !registerCart.length) {
    showToast("先に商品を明細へ追加してください");
    return;
  }
  if (["complete", "attributes"].includes(screen) && !registerLastCheckoutId) return;
  document.querySelectorAll("[data-register-screen]").forEach((panel) => {
    panel.classList.toggle("active", panel === target);
  });
  const order = ["items", "payment", "amount", "complete", "attributes"];
  const index = order.indexOf(screen);
  document.querySelectorAll("[data-register-screen-target]").forEach((button) => {
    const buttonIndex = order.indexOf(button.dataset.registerScreenTarget);
    button.classList.toggle("active", buttonIndex === index);
    button.classList.toggle("complete", buttonIndex < index);
  });
  if (screen === "payment") renderRegisterPaymentOrder();
  if (screen === "amount") renderRegisterCart();
  if (screen === "complete") renderRegisterCompleteSummary();
  if (screen === "attributes") syncCustomerRegionFields(document.getElementById("registerSaleForm"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderRegisterPaymentOrder() {
  const node = document.getElementById("registerPaymentOrder");
  if (!node) return;
  node.innerHTML = registerCart.length
    ? `${registerCart.map((line) => `<div><span>${escapeHtml(line.itemName)} × ${line.quantity}</span><strong>${yen.format(line.total)}</strong></div>`).join("")}<footer><span>合計</span><strong>${yen.format(registerCartTotal())}</strong></footer>`
    : '<div class="empty-note">明細がありません</div>';
}

function renderRegisterCompleteSummary() {
  const node = document.getElementById("registerCompleteSummary");
  if (!node) return;
  node.innerHTML = `<span>保存した会計</span><strong>${yen.format(registerLastTotal)}</strong>`;
}

function finishRegisterCheckout() {
  registerCart = [];
  selectedRegisterItem = null;
  selectedRegisterCategory = "";
  registerLastCheckoutId = "";
  const form = document.getElementById("registerSaleForm");
  form?.reset();
  setRegisterDefaultTime();
  renderAll();
  setRegisterScreen("items");
}

function saveRegisterAttributes() {
  if (!registerLastCheckoutId) {
    finishRegisterCheckout();
    return;
  }
  const form = document.getElementById("registerSaleForm");
  const data = new FormData(form);
  const attributes = {
    customerGender: data.get("customerGender") || "unknown",
    customerAgeGroup: data.get("customerAgeGroup") || "unknown",
    customerOrigin: data.get("customerOrigin") || "unknown",
    customerRegion: data.get("customerRegion") || "unknown",
  };
  state.sales.filter((sale) => sale.checkoutId === registerLastCheckoutId).forEach((sale) => Object.assign(sale, attributes));
  if (!saveState({ action: "販売属性を保存" })) return;
  showToast("購入者属性を保存しました");
  finishRegisterCheckout();
}

function openRegisterPicker() {
  const type = document.getElementById("registerItemType").value || "product";
  const title = document.getElementById("pickerTitle");
  const grid = document.getElementById("pickerGrid");
  const items = type === "product" ? state.products : state.parts;
  title.textContent = type === "product" ? "商品を選択" : "部品を選択";
  grid.innerHTML = items.length ? items.map((item) => {
    const price = type === "product" ? item.price : item.cost;
    return `
      <button type="button" class="picker-card" data-picker-type="${type}" data-picker-id="${item.id}">
        ${imageOrPlaceholder(item.image, item.name, "picker-image")}
        <span>${escapeHtml(item.name)}</span>
        ${type === "product" ? `<em>${escapeHtml(item.category || "品目未設定")}</em>` : ""}
        <strong>${yen.format(price)}</strong>
      </button>
    `;
  }).join("") : `<div class="empty-note">選択できる品目がありません</div>`;
  document.querySelectorAll("[data-picker-id]").forEach((button) => {
    button.onclick = () => {
      selectRegisterItem(button.dataset.pickerType, button.dataset.pickerId);
      closeRegisterPicker();
    };
  });
  document.getElementById("pickerBackdrop").classList.add("show");
  document.getElementById("pickerBackdrop").setAttribute("aria-hidden", "false");
}

function closeRegisterPicker() {
  document.getElementById("pickerBackdrop").classList.remove("show");
  document.getElementById("pickerBackdrop").setAttribute("aria-hidden", "true");
}

function selectRegisterItem(type, itemId) {
  const item = (type === "product" ? state.products : state.parts).find((entry) => entry.id === itemId);
  if (!item) return;
  const price = type === "product" ? toNumber(item.price) : toNumber(item.cost);
  selectedRegisterItem = {
    itemType: type,
    itemId,
    itemName: item.name,
    price,
  };
  document.getElementById("registerItemType").value = type;
  document.getElementById("registerItem").value = itemId;
  document.getElementById("registerUnitPrice").value = price;
  document.querySelectorAll("[data-register-type]").forEach((button) => {
    button.classList.toggle("active", button.dataset.registerType === type);
  });
  renderSelectedRegisterItem();
  renderRegisterTotals();
}

function renderSelectedRegisterItem() {
  const banner = document.getElementById("registerSelectedItem");
  const type = document.getElementById("registerItemType").value || "product";
  const label = type === "product" ? "商品" : "部品";
  banner.textContent = selectedRegisterItem
    ? `選択中: ${selectedRegisterItem.itemName} / ${yen.format(selectedRegisterItem.price)}`
    : `${label}を選択してください`;
}

function renderSelectedRegisterButton() {
  const container = document.getElementById("registerItemButtons");
  if (!selectedRegisterItem) {
    container.innerHTML = `<div class="empty-note">商品を選ぶと、ここに大きな追加ボタンが表示されます</div>`;
    return;
  }
  container.innerHTML = `
    <button type="button" class="selected register-add-tile" id="selectedRegisterAdd">
      <span>${escapeHtml(selectedRegisterItem.itemName)}</span>
      <strong>${yen.format(toNumber(document.getElementById("registerUnitPrice").value))}</strong>
      <em>押すたび数量が増えます</em>
    </button>
  `;
  document.getElementById("selectedRegisterAdd").onclick = addRegisterLine;
}

function addRegisterLine() {
  const line = buildRegisterLineFromCurrentInput();
  if (!line) return;
  const existing = registerCart.find((entry) => entry.itemType === line.itemType && entry.itemId === line.itemId && entry.unitPrice === line.unitPrice);
  if (existing) {
    existing.quantity += line.quantity;
    existing.total = existing.quantity * existing.unitPrice;
    existing.costAtSale = existing.quantity * existing.unitCostAtSale;
  } else {
    registerCart.push(line);
  }
  document.getElementById("registerQuantity").value = 1;
  renderRegisterCart();
  renderRegisterTotals();
}

function removeRegisterLine(id) {
  registerCart = registerCart.filter((line) => line.id !== id);
  renderRegisterCart();
  renderRegisterTotals();
}

function changeRegisterCartQuantity(id, step) {
  const line = registerCart.find((entry) => entry.id === id);
  if (!line) return;
  line.quantity = Math.max(1, Math.floor(toNumber(line.quantity) + step));
  line.total = line.quantity * line.unitPrice;
  line.costAtSale = line.quantity * line.unitCostAtSale;
  renderRegisterCart();
  renderRegisterTotals();
}

function clearRegisterCart() {
  registerCart = [];
  renderRegisterCart();
  renderRegisterTotals();
}

function registerCartTotal() {
  return registerCart.reduce((sum, line) => sum + toNumber(line.total), 0);
}

function registerDiscountAmount() {
  const input = document.getElementById("registerDiscount");
  const subtotal = registerCartTotal();
  const discount = Math.min(subtotal, Math.max(0, toNumber(input?.value)));
  if (input && toNumber(input.value) !== discount) input.value = discount;
  return discount;
}

function registerPayableTotal() {
  return Math.max(0, registerCartTotal() - registerDiscountAmount());
}

function renderRegisterAmountDetail() {
  const receipt = document.getElementById("registerReceiptLines");
  if (!receipt) return;
  const subtotal = registerCartTotal();
  const discount = registerDiscountAmount();
  const total = Math.max(0, subtotal - discount);
  if (!registerCart.length) {
    receipt.innerHTML = `<div class="empty-note">明細を追加するとここに表示されます</div>`;
    return;
  }
  receipt.innerHTML = `${registerCart.map((line) => `
    <div class="receipt-line-item">
      <span class="receipt-line-name">${escapeHtml(line.itemName)}</span>
      <span class="receipt-line-meta">${line.quantity}点 × ${yen.format(line.unitPrice)}</span>
      <strong>${yen.format(line.total)}</strong>
    </div>
  `).join("")}
  <div class="receipt-line-subtotal"><span>小計</span><strong>${yen.format(subtotal)}</strong></div>
  ${discount ? `<div class="receipt-line-discount"><span>割引</span><strong>−${yen.format(discount)}</strong></div>` : ""}
  <div class="receipt-line-total"><span>お支払い合計</span><strong>${yen.format(total)}</strong></div>`;
}

function renderRegisterCart() {
  const cart = document.getElementById("registerCart");
  const receipt = document.getElementById("registerReceiptLines");
  const nearTotal = document.getElementById("registerSummaryNearTotal");
  const itemCount = document.getElementById("registerItemCount");
  const itemTotal = document.getElementById("registerItemTotal");
  const count = registerCart.reduce((sum, line) => sum + toNumber(line.quantity), 0);
  const total = registerCartTotal();
  renderRegisterAmountDetail();
  if (itemCount) itemCount.textContent = `${count}点`;
  if (itemTotal) itemTotal.textContent = yen.format(total);
  if (!registerCart.length) {
    cart.innerHTML = `<div class="empty-note">明細はまだありません</div>`;
    receipt.innerHTML = `<div class="empty-note">明細を追加すると、ここに商品・数量・金額が表示されます</div>`;
    nearTotal.innerHTML = `<div class="empty-note">まとめ会計する商品がここに表示されます</div>`;
    renderRegisterPaymentOrder();
    return;
  }
  const lines = registerCart.map((line) => `
    <div class="cart-line">
      <div>
        <strong>${escapeHtml(line.itemName)}</strong>
        <span>${line.quantity}点 × ${yen.format(line.unitPrice)}</span>
      </div>
      <div class="cart-line-controls" aria-label="${escapeHtml(line.itemName)}の数量操作">
        <button type="button" class="ghost-button compact-button" data-cart-qty-step="-1" data-cart-line="${line.id}" aria-label="数量を減らす">−</button>
        <strong>${line.quantity}点</strong>
        <button type="button" class="ghost-button compact-button" data-cart-qty-step="1" data-cart-line="${line.id}" aria-label="数量を増やす">＋</button>
      </div>
      <strong class="cart-line-total">${yen.format(line.total)}</strong>
      <button type="button" class="icon-button" data-remove-line="${line.id}" aria-label="明細削除">×</button>
    </div>
  `).join("");
  cart.innerHTML = lines;
  receipt.innerHTML = registerCart.map((line) => `
    <div><span>${escapeHtml(line.itemName)} / ${line.quantity}点 × ${yen.format(line.unitPrice)}</span><strong>${yen.format(line.total)}</strong></div>
  `).join("");
  nearTotal.innerHTML = registerCart.map((line) => `
    <div><span>${escapeHtml(line.itemName)}</span><strong>${line.quantity}点 / ${yen.format(line.total)}</strong></div>
  `).join("");
  document.querySelectorAll("[data-remove-line]").forEach((button) => {
    button.onclick = () => removeRegisterLine(button.dataset.removeLine);
  });
  document.querySelectorAll("[data-cart-qty-step]").forEach((button) => {
    button.onclick = () => changeRegisterCartQuantity(button.dataset.cartLine, toNumber(button.dataset.cartQtyStep));
  });
  renderRegisterAmountDetail();
  renderRegisterPaymentOrder();
}

function renderRegisterTotals() {
  const paymentMethod = document.getElementById("registerPaymentMethod")?.value || "cash";
  const received = toNumber(document.getElementById("registerReceived").value);
  const total = registerPayableTotal();
  const change = paymentMethod === "cash" ? Math.max(0, received - total) : 0;
  const event = state.venues.find((venue) => venue.id === document.getElementById("registerEvent").value);
  const cashPanel = document.querySelector(".cash-input-panel");
  if (cashPanel) cashPanel.classList.toggle("is-cashless", paymentMethod === "cashless");
  document.querySelectorAll("[data-register-payment]").forEach((button) => {
    const active = button.dataset.registerPayment === paymentMethod;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const receivedInput = document.getElementById("registerReceived");
  if (receivedInput) receivedInput.disabled = paymentMethod === "cashless";
  document.getElementById("registerTotal").textContent = yen.format(total);
  document.getElementById("registerReceivedDisplay").textContent = paymentMethod === "cash" ? yen.format(received) : "—";
  document.getElementById("registerChange").textContent = yen.format(change);
  document.getElementById("registerEventLabel").textContent = event ? eventLabel(event) : "未設定";
  renderRegisterAmountDetail();
  updateRegisterSteps();
  renderRegisterChangeForecast(total, paymentMethod === "cash" ? received : 0);
  if (!document.getElementById("registerCart").innerHTML) renderRegisterCart();
}

function updateRegisterSteps() {
  const steps = [...document.querySelectorAll(".register-steps span")];
  if (!steps.length) return;
  const hasItems = registerCart.length > 0;
  steps.forEach((step, index) => {
    const active = hasItems ? index > 0 : index === 0;
    step.classList.toggle("active", active);
    step.classList.toggle("complete", hasItems && index === 0);
  });
}

function renderRegisterChangeForecast(total, received) {
  const node = document.getElementById("registerChangeForecast");
  if (!node) return;
  if (total <= 0) {
    node.innerHTML = `<span>返金額</span><strong>商品を追加してください</strong>`;
    return;
  }
  const diff = received - total;
  const label = diff >= 0 ? "返金額" : "不足額";
  const className = diff >= 0 ? "refund" : "shortage";
  node.innerHTML = `
    <span>${label}</span>
    <strong class="${className}">${yen.format(Math.abs(diff))}</strong>
  `;
}

function changeRegisterQuantity(step) {
  const input = document.getElementById("registerQuantity");
  input.value = Math.max(1, Math.floor(toNumber(input.value) + step));
  renderRegisterTotals();
}

function handleRegisterKeypad(event) {
  const button = event.target.closest("[data-key]");
  if (!button) return;
  const input = document.getElementById("registerReceived");
  const key = button.dataset.key;
  if (key === "exact") input.value = registerPayableTotal();
  else if (key === "clear") input.value = 0;
  else if (key === "back") input.value = String(Math.floor(toNumber(input.value) / 10));
  else if (key.startsWith("+")) input.value = toNumber(input.value) + toNumber(key.slice(1));
  else if (["1000", "500", "100"].includes(key)) input.value = toNumber(input.value) + toNumber(key);
  else input.value = `${input.value === "0" ? "" : input.value}${key}`;
  renderRegisterTotals();
}

async function editCheckout(checkoutKey) {
  const checkout = checkoutGroups(state.sales.filter(saleIsActive)).find((group) => group.key === checkoutKey);
  if (!checkout?.items.length) return;
  const first = checkout.items[0];
  const venue = state.venues.find((entry) => entry.id === first.venueId);
  if (venue?.status === "closed") {
    const ok = await showConfirm("締め処理後の会計を編集しますか？", "編集後はイベントの締め結果を再確認してください。");
    if (!ok) return;
  }
  const grossTotal = checkout.items.reduce((sum, sale) => sum + toNumber(sale.total) + toNumber(sale.discountAmount), 0);
  const discount = checkout.items.reduce((sum, sale) => sum + toNumber(sale.discountAmount), 0);
  const itemOptions = (type, selected = "") => {
    const items = type === "product" ? state.products : state.parts;
    return `<option value="">品目を選択</option>${items.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}`;
  };
  const lineMarkup = (sale = null) => {
    const type = sale?.itemType || "product";
    const itemId = sale?.itemId || "";
    return `<div class="checkout-editor-line" data-checkout-line ${sale ? `data-sale-id="${escapeHtml(sale.id)}"` : ""}>
      <select name="checkoutItemType" aria-label="販売対象"><option value="product" ${type === "product" ? "selected" : ""}>商品</option><option value="part" ${type === "part" ? "selected" : ""}>部品</option></select>
      <select name="checkoutItemId" aria-label="品目">${itemOptions(type, itemId)}</select>
      <input name="checkoutQuantity" type="number" min="0.01" step="0.01" value="${sale?.quantity ?? 1}" aria-label="数量" />
      <input name="checkoutUnitPrice" type="number" min="0" step="1" value="${sale?.unitPrice ?? 0}" aria-label="販売単価" />
      <button type="button" class="icon-button checkout-line-remove" data-remove-checkout-line aria-label="この明細を削除">×</button>
    </div>`;
  };
  const overlay = document.createElement("div");
  overlay.className = "checkout-editor-backdrop";
  overlay.innerHTML = `
    <section class="checkout-editor" role="dialog" aria-modal="true" aria-labelledby="checkoutEditorTitle">
      <div class="panel-header"><div><p class="eyebrow">会計単位</p><h3 id="checkoutEditorTitle">会計を一括編集</h3></div><button type="button" class="icon-button" data-close-checkout-editor>×</button></div>
      <form class="checkout-editor-form">
        <div class="checkout-editor-lines">
          <div class="checkout-editor-lines-heading"><strong>会計明細</strong><button type="button" class="ghost-button" data-add-checkout-line>＋明細を追加</button></div>
          <div class="checkout-editor-line-labels"><span>対象</span><span>品目</span><span>数量</span><span>単価</span><span></span></div>
          <div id="checkoutEditorLineList">${checkout.items.map(lineMarkup).join("")}</div>
          <p class="field-help checkout-editor-line-help">明細を外して保存すると、その明細は取消扱いになり在庫へ戻ります。販売履歴は取消済みとして残ります。</p>
        </div>
        <label>販売日<input name="checkoutDate" type="date" value="${escapeHtml(first.date || "")}" /></label>
        <label>販売時刻<input name="checkoutTime" type="time" value="${escapeHtml(first.soldTime || "")}" /></label>
        <label>割引額（円）<input name="checkoutDiscount" type="number" min="0" step="1" value="${discount}" /></label>
        <label>割引理由（任意）<input name="checkoutDiscountReason" type="text" maxlength="80" value="${escapeHtml(first.discountReason || "")}" placeholder="セット割、常連割など" /></label>
        <label>支払い方法<select name="checkoutPayment"><option value="cash" ${first.paymentMethod === "cash" ? "selected" : ""}>現金</option><option value="cashless" ${first.paymentMethod === "cashless" ? "selected" : ""}>キャッシュレス</option></select></label>
        <label>預り金<input name="checkoutReceived" type="number" min="0" step="1" value="${toNumber(first.receivedAmount)}" /></label>
        <div class="checkout-editor-total"><span>会計合計</span><strong data-checkout-total>${yen.format(Math.max(0, grossTotal - discount))}</strong></div>
        <div class="form-row"><label>性別<select name="checkoutGender"><option value="unknown">未回答</option><option value="female">女性</option><option value="male">男性</option><option value="other">その他</option></select></label><label>年齢層<select name="checkoutAge"><option value="unknown">未回答</option><option value="under20">20歳未満</option><option value="20s">20代</option><option value="30s">30代</option><option value="40s">40代</option><option value="50s">50代</option><option value="60plus">60代以上</option></select></label></div>
        <label>購入者区分<select name="checkoutOrigin"><option value="unknown">未回答</option><option value="domestic">日本人</option><option value="inbound">海外</option></select></label>
        <label data-checkout-region-field>海外の地域傾向<select name="checkoutRegion"><option value="unknown">未回答</option><option value="western">欧米系</option><option value="asian">アジア系</option><option value="other">その他</option></select></label>
      </form>
      <div class="form-actions"><button type="button" class="ghost-button" data-close-checkout-editor>キャンセル</button><button type="button" class="primary-button" data-save-checkout-editor>会計を保存</button></div>
    </section>`;
  document.body.appendChild(overlay);
  const form = overlay.querySelector(".checkout-editor-form");
  form.elements.checkoutGender.value = first.customerGender || "unknown";
  form.elements.checkoutAge.value = first.customerAgeGroup || "unknown";
  form.elements.checkoutOrigin.value = first.customerOrigin || "unknown";
  form.elements.checkoutRegion.value = first.customerRegion || "unknown";
  const syncRegion = () => { overlay.querySelector("[data-checkout-region-field]").hidden = form.elements.checkoutOrigin.value !== "inbound"; };
  const close = () => overlay.remove();
  const lineList = overlay.querySelector("#checkoutEditorLineList");
  lineList.querySelectorAll("[data-remove-checkout-line]").forEach((button) => {
    button.setAttribute("aria-label", "この明細を取消対象にする");
    button.title = "保存時にこの明細を取消します。履歴は残ります。";
  });
  const updateLineOptions = (line, preserve = true) => {
    const type = line.querySelector("[name=checkoutItemType]").value;
    const select = line.querySelector("[name=checkoutItemId]");
    const current = preserve ? select.value : "";
    select.innerHTML = itemOptions(type, current);
    if (current && [...select.options].some((option) => option.value === current)) select.value = current;
    else if (!preserve) select.value = "";
  };
  overlay.querySelectorAll("[data-checkout-line]").forEach((line) => {
    line.querySelector("[name=checkoutItemType]").addEventListener("change", () => updateLineOptions(line, false));
  });
  overlay.querySelector("[data-add-checkout-line]").addEventListener("click", () => {
    lineList.insertAdjacentHTML("beforeend", lineMarkup());
    const line = lineList.lastElementChild;
    const removeButton = line.querySelector("[data-remove-checkout-line]");
    removeButton.setAttribute("aria-label", "この明細を取消対象にする");
    removeButton.title = "保存時にこの明細を取消します。履歴は残ります。";
    line.querySelector("[name=checkoutItemType]").addEventListener("change", () => updateLineOptions(line, false));
  });
  lineList.addEventListener("click", (event) => {
    if (!event.target.closest("[data-remove-checkout-line]")) return;
    const lines = lineList.querySelectorAll("[data-checkout-line]");
    if (lines.length <= 1) {
      showToast("明細は1件以上必要です");
      return;
    }
    event.target.closest("[data-checkout-line]").remove();
  });
  const editorGrossTotal = () => [...lineList.querySelectorAll("[data-checkout-line]")].reduce((sum, line) => sum
    + toNumber(line.querySelector("[name=checkoutQuantity]")?.value) * toNumber(line.querySelector("[name=checkoutUnitPrice]")?.value), 0);
  const updateTotal = () => {
    const currentGrossTotal = editorGrossTotal();
    const nextDiscount = Math.min(currentGrossTotal, Math.max(0, toNumber(form.elements.checkoutDiscount.value)));
    form.elements.checkoutDiscount.value = nextDiscount;
    overlay.querySelector("[data-checkout-total]").textContent = yen.format(currentGrossTotal - nextDiscount);
  };
  form.elements.checkoutDiscount.addEventListener("input", updateTotal);
  lineList.addEventListener("input", updateTotal);
  form.elements.checkoutOrigin.addEventListener("change", syncRegion);
  overlay.querySelectorAll("[data-close-checkout-editor]").forEach((button) => button.addEventListener("click", close));
  overlay.querySelector("[data-save-checkout-editor]").addEventListener("click", () => {
    const nextPayment = form.elements.checkoutPayment.value === "cashless" ? "cashless" : "cash";
    const nextReceived = nextPayment === "cash" ? toNumber(form.elements.checkoutReceived.value) : 0;
    const lines = [...lineList.querySelectorAll("[data-checkout-line]")].map((line) => ({
      line,
      saleId: line.dataset.saleId || "",
      itemType: line.querySelector("[name=checkoutItemType]").value === "part" ? "part" : "product",
      itemId: line.querySelector("[name=checkoutItemId]").value,
      quantity: toNumber(line.querySelector("[name=checkoutQuantity]").value),
      unitPrice: toNumber(line.querySelector("[name=checkoutUnitPrice]").value),
    }));
    if (!lines.length || lines.some((line) => !line.itemId || line.quantity <= 0 || line.unitPrice < 0)) {
      showToast("商品・数量・販売単価を確認してください");
      return;
    }
    const nextGrossTotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
    const nextDiscount = Math.min(nextGrossTotal, Math.max(0, toNumber(form.elements.checkoutDiscount.value)));
    const nextTotal = Math.max(0, nextGrossTotal - nextDiscount);
    form.elements.checkoutDiscount.value = nextDiscount;
    const stockAvailable = new Map();
    const stockKey = (type, id) => `${type}:${id}`;
    checkout.items.forEach((sale) => {
      const key = stockKey(sale.itemType, sale.itemId);
      stockAvailable.set(key, (stockAvailable.get(key) || 0) + toNumber(sale.quantity));
    });
    lines.forEach((line) => {
      const key = stockKey(line.itemType, line.itemId);
      const itemList = line.itemType === "product" ? state.products : state.parts;
      const item = itemList.find((entry) => entry.id === line.itemId);
      stockAvailable.set(key, (stockAvailable.get(key) || 0) + toNumber(item?.stock));
      stockAvailable.set(`${key}:requested`, (stockAvailable.get(`${key}:requested`) || 0) + line.quantity);
    });
    const shortage = lines.find((line) => {
      const key = stockKey(line.itemType, line.itemId);
      return toNumber(stockAvailable.get(`${key}:requested`)) > toNumber(stockAvailable.get(key));
    });
    if (shortage) {
      showToast("在庫が不足するため保存できません");
      return;
    }
    const retainedIds = new Set(lines.map((line) => line.saleId).filter(Boolean));
    checkout.items.forEach((sale) => restoreSaleStock(sale));
    state.sales.filter((sale) => checkout.items.some((item) => item.id === sale.id) && !retainedIds.has(sale.id)).forEach((sale) => {
      sale.status = "cancelled";
      sale.cancelledAt = new Date().toISOString();
      sale.cancelReason = "会計明細から削除";
    });
    lines.forEach((line, index) => {
      const itemList = line.itemType === "product" ? state.products : state.parts;
      const item = itemList.find((entry) => entry.id === line.itemId);
      const sale = line.saleId ? state.sales.find((entry) => entry.id === line.saleId) : {
        id: uid("sale"),
        checkoutId: checkout.key,
        status: "completed",
        venueId: first.venueId,
        venueLabel: first.venueLabel,
        itemType: line.itemType,
        itemId: line.itemId,
        editHistory: [],
      };
      if (!item) return;
      sale.editHistory = Array.isArray(sale.editHistory) ? sale.editHistory : [];
      sale.editHistory.push({ at: new Date().toISOString(), action: "会計明細・一括編集", before: { itemType: sale.itemType, itemId: sale.itemId, quantity: sale.quantity, unitPrice: sale.unitPrice, total: sale.total } });
      sale.checkoutId = checkout.key;
      sale.date = form.elements.checkoutDate.value;
      sale.soldTime = form.elements.checkoutTime.value;
      sale.itemType = line.itemType;
      sale.itemId = line.itemId;
      sale.itemName = item.name;
      sale.quantity = line.quantity;
      sale.unitPrice = line.unitPrice;
      sale.unitCostAtSale = itemUnitCost(line.itemType, line.itemId);
      sale.discountAmount = index === 0 ? nextDiscount : 0;
      sale.discountReason = index === 0 ? form.elements.checkoutDiscountReason.value.trim() : "";
      sale.total = Math.max(0, line.quantity * line.unitPrice - sale.discountAmount);
      sale.paymentMethod = nextPayment;
      sale.receivedAmount = index === 0 ? nextReceived : 0;
      sale.changeDue = index === 0 ? Math.max(0, nextReceived - nextTotal) : 0;
      sale.customerGender = form.elements.checkoutGender.value;
      sale.customerAgeGroup = form.elements.checkoutAge.value;
      sale.customerOrigin = form.elements.checkoutOrigin.value;
      sale.customerRegion = form.elements.checkoutRegion.value;
      if (!state.sales.some((entry) => entry.id === sale.id)) state.sales.push(sale);
      item.stock = toNumber(item.stock) - line.quantity;
    });
    if (!saveState({ action: "会計一括編集" })) return;
    close();
    renderAll();
    showToast("会計を一括更新しました");
  });
  syncRegion();
}

function renderSales() {
  renderSaleFilterOptions();
  const sales = state.sales.filter(saleMatchesFilters);
  const checkoutNodes = checkoutGroups(sales.filter(saleIsActive)).map((checkout) => rowItem(
    `${checkout.date} 会計 ${checkout.items.length}明細`,
    `${saleVenueName(checkout.items[0])} / 合計 ${yen.format(checkout.total)} / 原価 ${yen.format(checkout.cost)} / 粗利 ${yen.format(checkout.total - checkout.cost)}${checkout.receivedAmount ? ` / 預かり ${yen.format(checkout.receivedAmount)} / おつり ${yen.format(checkout.changeDue)}` : ""} / ${checkout.items.map((sale) => `${sale.itemName} ${sale.quantity}点`).join("、")}`,
    `<button class="ghost-button" data-edit-checkout="${checkout.key}">一括編集（明細を変更）</button>`
  ));
  fillList("checkoutList", checkoutNodes, "会計履歴はまだありません");

  const nodes = sales.map((sale) => rowItem(
    `${sale.date} ${sale.itemName}`,
    `${sale.itemType === "product" ? "商品" : "部品"} / ${saleVenueName(sale)} / ${sale.quantity}点 / 売上 ${yen.format(sale.total)} / ${paymentMethodLabel(sale.paymentMethod)} / 原価 ${yen.format(saleCost(sale))} / 粗利 ${yen.format(saleProfit(sale))}${sale.receivedAmount ? ` / 預かり ${yen.format(sale.receivedAmount)} / おつり ${yen.format(sale.changeDue || 0)}` : ""}${saleAttributeSummary(sale)}${sale.memo ? ` / ${sale.memo}` : ""}`,
    `${saleIsActive(sale) ? `<button class="ghost-button" data-edit-sale="${sale.id}">編集</button><button class="ghost-button" data-cancel-sale="${sale.id}">取消</button>` : `<span class="badge warn">取消済み</span>`}<button class="ghost-button" data-print-sale="${sale.id}">レシート</button>`
  ));
  fillList("saleList", nodes, "販売履歴はまだありません");
  bindListActions();
}

const saleAttributeLabels = {
  customerGender: { unknown: "未回答", female: "女性", male: "男性", other: "その他" },
  customerAgeGroup: { unknown: "未回答", under20: "20歳未満", "20s": "20代", "30s": "30代", "40s": "40代", "50s": "50代", "60plus": "60代以上" },
  customerOrigin: { unknown: "未回答", domestic: "日本人", inbound: "海外" },
  customerRegion: { unknown: "未回答", western: "欧米系", asian: "アジア系", other: "その他" },
};

function saleAttributeLabel(field, value) {
  return saleAttributeLabels[field]?.[value] || saleAttributeLabels[field]?.unknown || "未回答";
}

function saleAttributeSummary(sale) {
  const time = sale.soldTime ? ` / ${sale.soldTime}` : "";
  const hasAttributes = sale.soldTime || [sale.customerGender, sale.customerAgeGroup, sale.customerOrigin, sale.customerRegion].some((value) => value && value !== "unknown");
  if (!hasAttributes) return "";
  const attributes = [
    saleAttributeLabel("customerGender", sale.customerGender),
    saleAttributeLabel("customerAgeGroup", sale.customerAgeGroup),
    saleAttributeLabel("customerOrigin", sale.customerOrigin),
    sale.customerOrigin === "inbound" ? saleAttributeLabel("customerRegion", sale.customerRegion) : "",
  ].filter(Boolean).join("・");
  return `${time} / 属性 ${attributes}`;
}

function renderSalesAnalysis() {
  const node = document.getElementById("saleAnalysisSummary");
  if (!node) return;
  const venueSelect = document.getElementById("analysisVenue");
  const currentVenue = venueSelect?.value || "";
  if (venueSelect) {
    venueSelect.innerHTML = `<option value="">すべてのイベント</option>${optionList(state.venues, "イベント未設定", eventLabel)}`;
    venueSelect.value = [...venueSelect.options].some((option) => option.value === currentVenue) ? currentVenue : "";
  }
  const period = document.getElementById("analysisPeriod")?.value || "all";
  const trendMode = document.getElementById("analysisTrendMode")?.value || "month";
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (period === "year") start.setFullYear(start.getFullYear() - 1);
  if (period === "quarter") start.setMonth(start.getMonth() - 3);
  if (period === "month") start.setMonth(start.getMonth() - 1);
  const startKey = period === "all" ? "" : `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  const sales = state.sales.filter((sale) => saleIsActive(sale)
    && (!startKey || String(sale.date || "") >= startKey)
    && (!venueSelect?.value || sale.venueId === venueSelect.value));
  const cancelled = state.sales.filter((sale) => !saleIsActive(sale)
    && (!startKey || String(sale.date || "") >= startKey)
    && (!venueSelect?.value || sale.venueId === venueSelect.value));
  if (!sales.length) {
    node.innerHTML = `<div class="empty-note">対象期間の販売データがありません。レジまたは出展イベントから販売を登録してください。</div>`;
    return;
  }

  const total = sales.reduce((sum, sale) => sum + toNumber(sale.total), 0);
  const quantity = sales.reduce((sum, sale) => sum + toNumber(sale.quantity), 0);
  const cost = sales.reduce((sum, sale) => sum + saleCost(sale), 0);
  const discount = sales.reduce((sum, sale) => sum + toNumber(sale.discountAmount), 0);
  const average = sales.length ? total / sales.length : 0;
  const yenValue = (value) => yen.format(Math.round(value));
  const percent = (value, base) => base ? `${Math.round(value / base * 100)}%` : "0%";
  const metric = (label, value, note = "") => `<div class="analysis-metric"><span>${label}</span><strong>${value}</strong>${note ? `<em>${note}</em>` : ""}</div>`;

  const trendMap = new Map();
  sales.forEach((sale) => {
    let key = String(sale.date || "").slice(0, 7) || "日付未設定";
    if (trendMode === "event") {
      key = venueSelect?.value ? String(sale.date || "").replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3") || "日付未設定" : saleVenueName(sale);
    }
    trendMap.set(key, (trendMap.get(key) || 0) + toNumber(sale.total));
  });
  const trendRows = [...trendMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const maxTrend = Math.max(...trendRows.map(([, value]) => value), 1);
  const trendLabel = trendMode === "event" ? (venueSelect?.value ? "イベント内の日別" : "イベント別") : "月別";
  const trendHtml = trendRows.slice(-12).map(([key, value]) => `<div class="analysis-bar-item"><div class="analysis-bar-value">${yenValue(value)}</div><div class="analysis-bar" style="height:${Math.max(8, value / maxTrend * 100)}%"></div><span>${escapeHtml(trendMode === "month" ? key.replace("-", "/") : key)}</span></div>`).join("");

  const productMap = new Map();
  const eventMap = new Map();
  const weekdayMap = new Map(["日", "月", "火", "水", "木", "金", "土"].map((day) => [day, { sales: 0, quantity: 0 }]));
  const prefectureMap = new Map();
  const paymentMap = new Map();
  sales.forEach((sale) => {
    const product = productMap.get(sale.itemName) || { sales: 0, quantity: 0 };
    product.sales += toNumber(sale.total); product.quantity += toNumber(sale.quantity); productMap.set(sale.itemName, product);
    const eventName = saleVenueName(sale);
    const event = eventMap.get(eventName) || { sales: 0, quantity: 0 };
    event.sales += toNumber(sale.total); event.quantity += toNumber(sale.quantity); eventMap.set(eventName, event);
    const payment = paymentMethodLabel(sale.paymentMethod);
    const paymentSummary = paymentMap.get(payment) || { sales: 0, quantity: 0 };
    paymentSummary.sales += toNumber(sale.total); paymentSummary.quantity += toNumber(sale.quantity); paymentMap.set(payment, paymentSummary);
    const venue = state.venues.find((entry) => entry.id === sale.venueId);
    const prefecture = venue?.prefecture || "未設定";
    const prefectureSummary = prefectureMap.get(prefecture) || { sales: 0, quantity: 0 };
    prefectureSummary.sales += toNumber(sale.total); prefectureSummary.quantity += toNumber(sale.quantity); prefectureMap.set(prefecture, prefectureSummary);
    const saleDate = new Date(`${sale.date}T00:00:00`);
    if (!Number.isNaN(saleDate.getTime())) {
      const weekday = weekdayMap.get(["日", "月", "火", "水", "木", "金", "土"][saleDate.getDay()]);
      weekday.sales += toNumber(sale.total); weekday.quantity += toNumber(sale.quantity);
    }
  });
  const rankingValue = (item, mode = "sales") => typeof item === "number" ? item : mode === "quantity" ? item.quantity : item.sales;
  const ranking = (map, mode = "sales") => [...map.entries()].sort((a, b) => rankingValue(b[1], mode) - rankingValue(a[1], mode)).slice(0, 8);
  const rankingHtml = (map, mode = "sales") => {
    const rows = ranking(map, mode);
    const max = Math.max(...rows.map(([, item]) => rankingValue(item, mode)), 1);
    return rows.map(([name, item]) => {
      const current = rankingValue(item, mode);
      const value = mode === "quantity" ? `${current}点` : mode === "both" ? `${yenValue(item.sales)} / ${item.quantity}点` : yenValue(current);
      const width = current / max * 100;
      return `<div class="analysis-rank"><div><span>${escapeHtml(name)}</span><strong>${value}</strong></div><i style="width:${width}%"></i></div>`;
    }).join("");
  };

  const pieChart = (map, mode, label) => {
    const sorted = [...map.entries()].sort((a, b) => rankingValue(b[1], mode) - rankingValue(a[1], mode));
    const rows = sorted.slice(0, 5);
    if (sorted.length > 5) {
      const rest = sorted.slice(5).reduce((sum, [, item]) => {
        if (typeof item === "number") return sum + item;
        sum.sales += item.sales; sum.quantity += item.quantity;
        return sum;
      }, typeof sorted[0]?.[1] === "number" ? 0 : { sales: 0, quantity: 0 });
      rows.push(["その他", rest]);
    }
    const valueOf = (item) => rankingValue(item, mode);
    const totalValue = rows.reduce((sum, [, item]) => sum + valueOf(item), 0) || 1;
    let cursor = 0;
    const colors = ["#087aa0", "#22c3dc", "#12a98f", "#f0a93d", "#ff7f6e", "#7357a6"];
    const segments = rows.map(([, item], index) => {
      const next = cursor + valueOf(item) / totalValue * 100;
      const segment = `${colors[index % colors.length]} ${cursor}% ${next}%`;
      cursor = next;
      return segment;
    }).join(", ");
    const legend = rows.map(([name, item], index) => `<div class="analysis-pie-legend-row"><i style="background:${colors[index % colors.length]}"></i><span>${escapeHtml(name)}</span><strong>${percent(valueOf(item), totalValue * 1)}${mode === "quantity" ? ` / ${valueOf(item)}点` : ` / ${yenValue(valueOf(item))}`}</strong></div>`).join("");
    return `<div class="analysis-pie-wrap"><div class="analysis-pie" role="img" aria-label="${escapeHtml(label)}" style="background:conic-gradient(${segments || "#dceef2 0 100%"})"></div><div class="analysis-pie-legend">${legend || "<span class=\"field-help\">データなし</span>"}</div></div>`;
  };

  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  sales.forEach((sale) => {
    if (!sale.soldTime || !/^\d{2}:\d{2}/.test(sale.soldTime)) return;
    const date = new Date(`${sale.date}T00:00:00`);
    const day = Number.isNaN(date.getTime()) ? 0 : date.getDay();
    const hour = Math.min(23, Number(sale.soldTime.slice(0, 2)));
    heat[day][hour] += toNumber(sale.total);
  });
  const maxHeat = Math.max(...heat.flat(), 1);
  const heatHtml = weekdays.map((day, dayIndex) => `<div class="analysis-heat-row"><b>${day}</b>${heat[dayIndex].map((value, hour) => `<span title="${day}曜 ${hour}時: ${yenValue(value)}" style="--heat:${value ? Math.max(.12, value / maxHeat) : 0}">${value ? "" : ""}</span>`).join("")}</div>`).join("");
  const heatLegend = Array.from({ length: 24 }, (_, hour) => `<span>${hour % 2 === 0 ? `${hour}時` : ""}</span>`).join("");
  const attributeGroups = [["性別", "customerGender"], ["年齢層", "customerAgeGroup"], ["購入者区分", "customerOrigin"]];
  const attributeMaps = new Map();
  const attributesHtml = attributeGroups.map(([title, field]) => {
    const map = new Map();
    sales.forEach((sale) => {
      const key = sale[field] || "unknown";
      const current = map.get(key) || { sales: 0, quantity: 0 };
      current.sales += toNumber(sale.total); current.quantity += toNumber(sale.quantity); map.set(key, current);
    });
    attributeMaps.set(field, map);
    const rows = [...map.entries()].sort((a, b) => b[1].sales - a[1].sales).map(([key, value]) => `<div class="analysis-row"><span>${saleAttributeLabel(field, key)}</span><strong>${yenValue(value.sales)}</strong><em>${percent(value.sales, total)} / ${value.quantity}点</em></div>`).join("");
    return `<section class="analysis-group"><h4>${title}</h4>${rows}</section>`;
  }).join("");

  node.innerHTML = `
    <div class="analysis-reading-guide"><strong>この画面の見方</strong><span>期間とイベントを選ぶと、対象の売上だけに各グラフが切り替わります。取消・返品は売上から除外し、件数だけを表示します。</span></div>
    <div class="analysis-metrics">${metric("売上合計", yenValue(total), `${sales.length}明細`)}${metric("販売数", `${quantity}点`, `平均 ${yenValue(quantity / sales.length)}点 / 明細`)}${metric("粗利益", yenValue(total - cost), `原価 ${yenValue(cost)}`)}${metric("平均会計", yenValue(average), `値引き ${yenValue(discount)}`)}${metric("取消・返品", `${cancelled.length}件`, "履歴に保存")}</div>
    <div class="analysis-grid">
      <section class="analysis-card analysis-trend"><div class="analysis-card-heading"><h4>売上推移</h4><span>${trendLabel}</span></div><div class="analysis-bars">${trendHtml}</div>${trendMode === "event" && venueSelect?.value ? `<p class="field-help">イベントを1件選択しているため、イベント内の日別売上を表示しています。</p>` : ""}</section>
      <section class="analysis-card analysis-product-composition"><div class="analysis-card-heading"><h4>商品構成比</h4><span>円グラフとランキング</span></div><div class="analysis-product-layout"><div class="analysis-product-pies"><div><h5>売上金額</h5>${pieChart(productMap, "sales", "商品別売上金額の構成比")}</div><div><h5>販売数量</h5>${pieChart(productMap, "quantity", "商品別販売数量の構成比")}</div></div><div class="analysis-product-ranking"><h5>商品別ランキング</h5><div class="analysis-ranking">${rankingHtml(productMap, "both")}</div></div></div></section>
      <section class="analysis-card analysis-heat-card"><div class="analysis-card-heading"><h4>時間帯別ヒートマップ</h4><span>曜日 × 時間帯の売上</span></div><div class="analysis-heat-scroll"><div class="analysis-heat-labels"><b></b>${heatLegend}</div>${heatHtml}</div><div class="analysis-heat-legend"><span>少ない</span><i></i><i></i><i></i><i></i><span>多い</span></div><p class="field-help">色が濃い時間帯ほど売上金額が大きくなります。販売時刻がある明細のみ反映されます。</p></section>
      <section class="analysis-card"><div class="analysis-card-heading"><h4>出展イベント別</h4><span>金額 / 数量</span></div><div class="analysis-ranking">${rankingHtml(eventMap, "both")}</div></section>
      <section class="analysis-card"><div class="analysis-card-heading"><h4>曜日別売上</h4><span>金額 / 数量</span></div><div class="analysis-ranking">${rankingHtml(weekdayMap, "both")}</div></section>
      <section class="analysis-card analysis-pie-card"><div class="analysis-card-heading"><h4>購入者属性の構成比</h4><span>売上金額</span></div><div class="analysis-attribute-pies"><div><h5>性別</h5>${pieChart(attributeMaps.get("customerGender"), "sales", "性別別売上金額の構成比")}</div><div><h5>年齢層</h5>${pieChart(attributeMaps.get("customerAgeGroup"), "sales", "年齢層別売上金額の構成比")}</div><div><h5>日本人 / 海外</h5>${pieChart(attributeMaps.get("customerOrigin"), "sales", "購入者区分別売上金額の構成比")}</div></div><div class="analysis-groups analysis-groups-compact">${attributesHtml}</div></section>
      <section class="analysis-card analysis-pie-card"><div class="analysis-card-heading"><h4>出店都道府県の構成比</h4><span>金額と数量</span></div><div class="analysis-pie-columns"><div><h5>売上金額</h5>${pieChart(prefectureMap, "sales", "都道府県別売上金額の構成比")}</div><div><h5>販売数量</h5>${pieChart(prefectureMap, "quantity", "都道府県別販売数量の構成比")}</div></div><div class="analysis-ranking analysis-ranking-compact">${rankingHtml(prefectureMap, "both")}</div></section>
      <section class="analysis-card"><div class="analysis-card-heading"><h4>支払方法の構成</h4><span>金額 / 数量</span></div><div class="analysis-ranking">${rankingHtml(paymentMap, "both")}</div></section>
      <section class="analysis-card"><div class="analysis-card-heading"><h4>購入者属性</h4><span>金額比率 / 数量</span></div><div class="analysis-groups">${attributesHtml}</div></section>
    </div>`;
}

function renderSaleFilterOptions() {
  const select = document.getElementById("saleFilterVenue");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">すべて</option>${optionList(state.venues, "出展イベントなし", eventLabel)}`;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function saleMatchesFilters(sale) {
  const venue = document.getElementById("saleFilterVenue")?.value || "";
  const type = document.getElementById("saleFilterType")?.value || "";
  const from = document.getElementById("saleFilterFrom")?.value || "";
  const to = document.getElementById("saleFilterTo")?.value || "";
  const keyword = (document.getElementById("saleFilterKeyword")?.value || "").trim().toLowerCase();
  if (venue && sale.venueId !== venue) return false;
  if (type && sale.itemType !== type) return false;
  if (from && (sale.date || "") < from) return false;
  if (to && (sale.date || "") > to) return false;
  if (keyword && !`${sale.itemName || ""} ${sale.memo || ""} ${saleVenueName(sale)}`.toLowerCase().includes(keyword)) return false;
  return true;
}

function checkoutGroups(sales) {
  const map = new Map();
  sales.forEach((sale) => {
    const key = sale.checkoutId || sale.id;
    const current = map.get(key) || {
      key,
      date: sale.date,
      venueId: sale.venueId,
      total: 0,
      cost: 0,
      receivedAmount: 0,
      changeDue: 0,
      refundAmount: 0,
      items: [],
    };
    current.total += toNumber(sale.total);
    current.cost += saleCost(sale);
    current.receivedAmount += toNumber(sale.receivedAmount);
    current.changeDue += toNumber(sale.changeDue);
    current.refundAmount += toNumber(sale.refundAmount);
    current.items.push(sale);
    map.set(key, current);
  });
  return [...map.values()].sort((a, b) => `${b.date}${b.key}`.localeCompare(`${a.date}${a.key}`));
}

function renderExpenses() {
  const nodes = [...state.venues]
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .map((venue) => {
      const summary = eventSalesSummary(venue.id);
      return rowItem(
        eventLabel(venue),
        `売上 ${yen.format(summary.salesTotal)} / 販売 ${summary.quantityTotal}点 / 原価 ${yen.format(summary.costTotal)} / 費用 ${yen.format(summary.expenseTotal)} / 利益 ${yen.format(summary.profit)} / 内訳: ${summary.itemText}`,
        `<button class="ghost-button" data-edit-venue="${venue.id}">編集</button>`
      );
    });
  const legacy = state.expenses.map((expense) => rowItem(
    `${expense.date || ""} ${expense.category || "旧経費"}`,
    `${expense.venueLabel || venueName(expense.venueId)} / ${yen.format(expense.amount)}${expense.memo ? ` / ${expense.memo}` : ""}`,
    `<button class="danger-button" data-delete-expense="${expense.id}">削除</button>`
  ));
  fillList("expenseList", [...nodes, ...legacy], "出展イベントに費用を登録してください");
  bindListActions();
}

function renderExpenseOptions() {
  const select = document.getElementById("expenseVenue");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">イベントなし</option>${optionList(state.venues, "イベントなし", eventLabel)}`;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function saveStockAdjustment(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const itemType = data.get("itemType");
  const itemId = data.get("itemId");
  const list = itemType === "product" ? state.products : state.parts;
  const item = list.find((entry) => entry.id === itemId);
  if (!item) return;
  const before = toNumber(item.stock);
  const after = Math.max(0, toNumber(data.get("actualStock")));
  item.stock = after;
  state.stockAdjustments.unshift({
    id: uid("adjustment"),
    at: new Date().toISOString(),
    userId: "owner",
    itemType,
    itemId,
    itemName: item.name,
    before,
    after,
    delta: after - before,
    reason: data.get("reason").trim(),
  });
  state.stockAdjustments = state.stockAdjustments.slice(0, 200);
  if (!saveState({ action: "在庫調整・棚卸し" })) return;
  event.currentTarget.reset();
  renderAll();
  showToast("在庫を確定しました");
}

function renderAdjustmentOptions() {
  const type = document.getElementById("adjustmentItemType")?.value || "product";
  const select = document.getElementById("adjustmentItem");
  if (!select) return;
  const list = type === "product" ? state.products : state.parts;
  const current = select.value;
  select.innerHTML = optionList(list, "品目なし");
  if ([...select.options].some((option) => option.value === current)) select.value = current;
  const item = list.find((entry) => entry.id === select.value);
  const actual = document.getElementById("actualStock");
  if (item && actual && !actual.value) actual.value = item.stock;
}

function renderManagement() {
  updateStorageStatus(true);
  const barcodePanelTitle = document.querySelector("#barcodeSearch")?.closest(".panel")?.querySelector("h3");
  if (barcodePanelTitle) barcodePanelTitle.textContent = "商品コード・バーコード";
  renderAdjustmentOptions();
  renderManagementSummary();
  renderAdjustmentHistory();
  renderSupplierSummary();
  renderSalesSummary();
  renderBarcodeSearch();
  renderUsers();
  renderBackupHistory();
  renderOperationLogs();
  renderMasterLists();
}

function saveMasterForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const key = form.dataset.masterForm;
  const value = form.elements.value.value.trim();
  if (!key || !value) return;
  form.reset();
  openMasterEntryModal(key, value);
}

function renderMasterLists() {
  const render = (id, key) => {
    const node = document.getElementById(id);
    if (!node || !state.masters) return;
    const values = state.masters[key] || [];
    node.innerHTML = values.length
      ? values.map((value) => {
        const name = key === "suppliers" ? value.name : value;
        const detail = key === "suppliers" ? [value.address, value.memo].filter(Boolean).join(" / ") : "";
        return `<span class="master-chip" title="${escapeHtml(detail)}"><strong>${escapeHtml(name)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}<button type="button" data-delete-master="${key}" data-master-value="${escapeHtml(name)}" aria-label="${escapeHtml(name)}を削除">×</button></span>`;
      }).join("")
      : '<span class="empty-note">登録されていません</span>';
    node.querySelectorAll("[data-delete-master]").forEach((button) => {
      button.addEventListener("click", () => {
        const masterKey = button.dataset.deleteMaster;
        const valueToDelete = button.dataset.masterValue;
        state.masters[masterKey] = (state.masters[masterKey] || []).filter((value) => (masterKey === "suppliers" ? value.name : value) !== valueToDelete);
        if (!saveState({ action: "マスタを削除" })) return;
        renderMasterLists();
        renderPartMasterOptions();
      });
    });
  };
  render("partCategoryMasterList", "partCategories");
  render("supplierMasterList", "suppliers");
}

function renderAdjustmentHistory() {
  const node = document.getElementById("adjustmentHistory");
  if (!node) return;
  const rows = (state.stockAdjustments || []).slice(0, 10).map((entry) => rowItem(
    `${entry.itemName} / ${formatDateTime(entry.at)}`,
    `${entry.before} → ${entry.after}（${entry.delta >= 0 ? "+" : ""}${entry.delta}） / ${entry.reason}`,
  ));
  fillList("adjustmentHistory", rows, "棚卸し履歴がありません");
}

function renderManagementSummary() {
  const node = document.getElementById("managementSummary");
  if (!node) return;
  const activeSales = state.sales.filter(saleIsActive);
  const months = new Set(activeSales.map((sale) => (sale.date || "").slice(0, 7)).filter(Boolean));
  const inventoryValue = state.parts.reduce((sum, item) => sum + toNumber(item.stock) * toNumber(item.cost), 0)
    + state.products.reduce((sum, item) => sum + toNumber(item.stock) * productCost(item), 0);
  node.innerHTML = [
    ["販売件数", `${activeSales.length}件`],
    ["売上合計", yen.format(activeSales.reduce((sum, sale) => sum + toNumber(sale.total), 0))],
    ["在庫金額", yen.format(inventoryValue)],
    ["集計月数", `${months.size}か月`],
    ["調整履歴", `${state.stockAdjustments.length}件`],
    ["操作ログ", `${state.operationLogs.length}件`],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function renderSupplierSummary() {
  const node = document.getElementById("supplierSummary");
  if (!node) return;
  const map = new Map();
  state.parts.forEach((part) => (part.purchases || []).forEach((purchase) => {
    const key = purchase.supplier || "仕入先未設定";
    const current = map.get(key) || { qty: 0, amount: 0, count: 0 };
    current.qty += toNumber(purchase.qty);
    current.amount += toNumber(purchase.total) || toNumber(purchase.qty) * toNumber(purchase.unitCost);
    current.count += 1;
    map.set(key, current);
  }));
  const rows = [...map.entries()].sort((a, b) => b[1].amount - a[1].amount).map(([name, value]) =>
    rowItem(name, `${value.count}件 / 数量 ${value.qty} / 仕入合計 ${yen.format(value.amount)}`));
  fillList("supplierSummary", rows, "仕入履歴がありません");
}

function renderSalesSummary() {
  const node = document.getElementById("salesSummary");
  if (!node) return;
  const monthly = new Map();
  state.sales.filter(saleIsActive).forEach((sale) => {
    const month = (sale.date || "日付なし").slice(0, 7);
    const current = monthly.get(month) || { total: 0, count: 0, qty: 0 };
    current.total += toNumber(sale.total);
    current.count += 1;
    current.qty += toNumber(sale.quantity);
    monthly.set(month, current);
  });
  const events = new Map();
  state.sales.filter(saleIsActive).forEach((sale) => {
    const key = saleVenueName(sale);
    const current = events.get(key) || { total: 0, count: 0 };
    current.total += toNumber(sale.total);
    current.count += 1;
    events.set(key, current);
  });
  const rows = [
    ...[...monthly.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([name, value]) => rowItem(`月別 / ${name}`, `${value.count}件 / ${value.qty}点 / ${yen.format(value.total)}`)),
    ...[...events.entries()].sort((a, b) => b[1].total - a[1].total).map(([name, value]) => rowItem(`イベント別 / ${name}`, `${value.count}件 / ${yen.format(value.total)}`)),
  ];
  fillList("salesSummary", rows, "販売履歴がありません");
}

function renderBarcodeSearch() {
  const node = document.getElementById("barcodeResult");
  const query = document.getElementById("barcodeSearch")?.value.trim().toLowerCase();
  if (!node || !query) {
    if (node) node.innerHTML = `<div class="empty-note">コードを入力すると商品・部品を検索します</div>`;
    return;
  }
  const matches = [
    ...state.products.map((item) => ({ ...item, itemType: "商品" })),
    ...state.parts.map((item) => ({ ...item, itemType: "部品" })),
  ].filter((item) => String(item.barcode || "").toLowerCase().includes(query));
  fillList("barcodeResult", matches.map((item) => rowItem(`${item.itemType} / ${item.name}`, `コード: ${item.barcode || "未設定"} / 在庫: ${item.stock}`)), "一致するコードがありません");
}

function generateQrCode() {
  const text = document.getElementById("qrText")?.value.trim();
  const canvas = document.getElementById("qrCanvas");
  if (!text || !canvas || !window.QRCode) {
    showToast("QRコード文字列を入力してください");
    return;
  }
  window.QRCode.toCanvas(canvas, text, { width: 220, margin: 2 }, (error) => {
    if (error) {
      console.error(error);
      showToast("QRコードを生成できませんでした");
    } else {
      showToast("QRコードを表示しました");
    }
  });
}

function saveUser(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  state.users = Array.isArray(state.users) ? state.users : [];
  state.users.push({ id: uid("user"), name: data.get("name").trim(), role: "admin" });
  if (!saveState({ action: "ユーザー追加" })) return;
  event.currentTarget.reset();
  renderManagement();
}

function renderUsers() {
  const select = document.getElementById("activeUser");
  const list = document.getElementById("userList");
  if (!select || !list) return;
  document.getElementById("userForm")?.setAttribute("hidden", "hidden");
  select.closest("label")?.setAttribute("hidden", "hidden");
  list.setAttribute("hidden", "hidden");
  const current = select.value || "owner";
  select.innerHTML = state.users.map((user) => `<option value="${user.id}">${escapeHtml(user.name)}（${escapeHtml(user.role)}）</option>`).join("");
  if ([...select.options].some((option) => option.value === current)) select.value = current;
  list.innerHTML = state.users.map((user) => `<div class="row-item"><div><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(user.role)}</span></div></div>`).join("");
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadCsv(filename, headers, rows) {
  const csv = "\\uFEFF" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\\r\\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function exportCsv(type) {
  if (type === "sales") downloadCsv(`marche-stock-sales-${new Date().toISOString().slice(0, 10)}.csv`, ["日付", "イベント", "品目", "数量", "単価", "合計", "状態", "メモ"], state.sales.map((sale) => [sale.date, saleVenueName(sale), sale.itemName, sale.quantity, sale.unitPrice, sale.total, saleIsActive(sale) ? "有効" : "取消済み", sale.memo]));
  if (type === "parts") downloadCsv("marche-stock-parts.csv", ["部品名", "仕入先", "在庫", "単位", "単価", "保管場所"], state.parts.map((item) => [item.name, item.supplier, item.stock, item.unit, item.cost, item.location]));
  if (type === "products") downloadCsv("marche-stock-products.csv", ["商品名", "カテゴリ", "在庫", "販売価格", "原価", "コード"], state.products.map((item) => [item.name, item.category, item.stock, item.price, productCost(item), item.barcode]));
  showToast("CSVを書き出しました");
}

function printLastReceipt() {
  const sale = state.sales[0];
  if (!sale) { showToast("印刷する販売履歴がありません"); return; }
  printReceipt(sale);
}

function printReceipt(sale) {
  const sheet = document.createElement("section");
  sheet.className = "print-sheet";
  sheet.innerHTML = `<h1>Marche Stock</h1><p>${escapeHtml(sale.date || "")} / ${escapeHtml(saleVenueName(sale))}</p><hr><p>${escapeHtml(sale.itemName)} × ${sale.quantity}</p><h2>${yen.format(sale.total)}</h2><p>お預かり ${yen.format(sale.receivedAmount || 0)} / おつり ${yen.format(sale.changeDue || 0)}</p>`;
  document.body.appendChild(sheet);
  const cleanup = () => { sheet.remove(); window.removeEventListener("afterprint", cleanup); };
  window.addEventListener("afterprint", cleanup);
  window.print();
}

function renderBackupHistory() {
  renderBackupHistoryInto("backupHistory");
}

function renderBackupHistoryInto(targetId) {
  const node = document.getElementById(targetId);
  if (!node) return;
  const backups = readBackups();
  node.innerHTML = backups.length ? backups.map((backup, index) => `<div class="row-item"><div><strong>${formatDateTime(backup.savedAt)}</strong><span>第${index + 1}世代</span></div><button class="ghost-button" type="button" data-restore-backup="${index}">この状態に戻す</button></div>`).join("") : `<div class="empty-note">バックアップ履歴がありません</div>`;
  node.querySelectorAll("[data-restore-backup]").forEach((button) => button.addEventListener("click", () => restoreBackupAt(Number(button.dataset.restoreBackup))));
}

function renderDataManagement() {
  const detail = document.getElementById("dataStorageStatus");
  if (detail) {
    const size = storageUsageBytes();
    const backups = readBackups();
    detail.innerHTML = `<div class="storage-detail-row"><span>現在のデータ容量</span><strong>${formatBytes(size)}</strong></div><div class="storage-detail-row"><span>自動バックアップ</span><strong>${backups.length} / 10世代</strong></div>`;
  }
  renderBackupHistoryInto("dataBackupHistory");
  renderArchivedData();
  renderDeletedSales();
  const status = document.getElementById("backupStatus");
  const dataStatus = document.getElementById("dataBackupStatus");
  if (dataStatus && status) dataStatus.innerHTML = status.innerHTML;
}

function renderDeletedSales() {
  const node = document.getElementById("deletedSalesList");
  if (!node) return;
  const cancelled = state.sales.filter((sale) => !saleIsActive(sale));
  node.innerHTML = cancelled.length
    ? cancelled.map((sale) => rowItem(
        `${sale.date || "日付未設定"} / ${sale.itemName}`,
        `${sale.quantity}点 / ${saleVenueName(sale)} / ${yen.format(sale.total)} / 取消済み`,
        `<button class="danger-button" data-delete-sale="${sale.id}">完全削除</button>`,
      )).join("")
    : `<div class="empty-note">完全削除できる取消済み販売はありません</div>`;
  bindDelete("#deletedSalesList [data-delete-sale]", state.sales, "deleteSale");
}

function renderArchivedData() {
  const node = document.getElementById("archivedDataList");
  if (!node) return;
  const parts = (state.archivedParts || []).map((item) => ({ ...item, archivedType: "part", archivedLabel: "部品" }));
  const products = (state.archivedProducts || []).map((item) => ({ ...item, archivedType: "product", archivedLabel: "商品" }));
  const items = [...parts, ...products];
  node.innerHTML = items.length
    ? items.map((item) => rowItem(
        `${item.archivedLabel} / ${item.name}`,
        `在庫 ${item.stock} / ${item.memo || "削除済みデータ"}`,
        `<button class="ghost-button" type="button" data-restore-archived-type="${item.archivedType}" data-restore-archived-id="${item.id}">復元</button>`,
      )).join("")
    : `<div class="empty-note">削除済みデータはありません</div>`;
  node.querySelectorAll("[data-restore-archived-id]").forEach((button) => {
    button.addEventListener("click", () => restoreArchivedItem(button.dataset.restoreArchivedType, button.dataset.restoreArchivedId));
  });
}

function renderIntegrityCheck() {
  const node = document.getElementById("integrityList");
  if (!node) return;
  const issues = [];
  const partIds = new Set(state.parts.map((item) => item.id));
  const productIds = new Set(state.products.map((item) => item.id));
  const venueIds = new Set(state.venues.map((item) => item.id));
  state.parts.forEach((part) => {
    if (toNumber(part.stock) < 0) issues.push(`部品「${part.name}」の在庫がマイナスです。`);
    (part.purchases || []).forEach((purchase) => {
      if (toNumber(purchase.qty) <= 0) issues.push(`部品「${part.name}」に数量が不正な仕入履歴があります。`);
    });
  });
  state.products.forEach((product) => {
    if (toNumber(product.stock) < 0) issues.push(`商品「${product.name}」の在庫がマイナスです。`);
    (product.recipe || []).forEach((row) => {
      if (!partIds.has(row.partId)) issues.push(`商品「${product.name}」のレシピに存在しない部品があります。`);
    });
  });
  state.sales.forEach((sale) => {
    const exists = sale.itemType === "product" ? productIds.has(sale.itemId) : partIds.has(sale.itemId);
    if (!exists) issues.push(`売上「${sale.itemName}」が存在しない品目を参照しています。`);
    if (sale.venueId && !venueIds.has(sale.venueId)) issues.push(`売上「${sale.itemName}」が存在しないイベントを参照しています。`);
  });
  if (!issues.length) {
    node.innerHTML = `<div class="empty-note good">データに問題は見つかりませんでした。</div>`;
    showToast("データ診断が完了しました。");
    return;
  }
  node.innerHTML = issues.slice(0, 50).map((issue) => `<div class="row-item"><div><strong>確認が必要</strong><p>${escapeHtml(issue)}</p></div></div>`).join("");
  showToast(`${issues.length}件の確認事項があります。`);
}

async function restoreArchivedItem(type, id) {
  const sourceKey = type === "product" ? "archivedProducts" : "archivedParts";
  const targetKey = type === "product" ? "products" : "parts";
  const source = state[sourceKey] || [];
  const index = source.findIndex((item) => item.id === id);
  if (index < 0) return;
  if ((state[targetKey] || []).some((item) => item.id === id)) {
    showToast("同じIDのデータがすでに存在するため復元できません。");
    return;
  }
  const ok = await showConfirm("削除済みデータを復元しますか？", `${source[index].name}を現行一覧へ戻します。`);
  if (!ok) return;
  state[targetKey] = Array.isArray(state[targetKey]) ? state[targetKey] : [];
  state[targetKey].push(source[index]);
  source.splice(index, 1);
  if (!saveState({ action: "削除済みデータ復元" })) return;
  renderAll();
  showToast("削除済みデータを復元しました。");
}

async function restoreBackupAt(index) {
  const backup = readBackups()[index];
  if (!backup) return;
  const ok = await showConfirm("バックアップを復元しますか？", `${formatDateTime(backup.savedAt)}の状態に戻します。現在の状態は別途バックアップします。`);
  if (!ok) return;
  try {
    const data = await backupData(backup);
    writeAutoBackup();
    Object.assign(state, normalizeImportedState(data));
    if (!saveState({ action: "任意バックアップ復元" })) return;
  } catch (error) {
    console.error(error);
    showToast("バックアップの内容を確認できないため復元できませんでした。");
    return;
  }
  renderAll();
  showToast("バックアップを復元しました");
}

function renderOperationLogs() {
  const node = document.getElementById("operationLogList");
  if (!node) return;
  const logs = (state.operationLogs || []).slice(0, 20).map((log) => rowItem(formatDateTime(log.at), `${log.action} / ${log.userId}`));
  fillList("operationLogList", logs, "操作ログがありません");
}

function renderRecipePartOptions() {
  document.querySelectorAll('[name="recipePart"]').forEach((select) => {
    const current = select.value;
    select.innerHTML = optionList(state.parts, "部品なし");
    select.value = current;
  });
}

function fillSalePrice() {
  const type = document.getElementById("saleItemType").value;
  const itemId = document.getElementById("saleItem").value;
  const item = (type === "product" ? state.products : state.parts).find((entry) => entry.id === itemId);
  const price = type === "product" ? item?.price : item?.cost;
  document.querySelector("#saleForm [name=unitPrice]").value = price || 0;
  renderSalePos();
}

function renderSalePos() {
  const form = document.getElementById("saleForm");
  const quantity = toNumber(form.elements.quantity.value);
  const unitPrice = toNumber(form.elements.unitPrice.value);
  const grossTotal = quantity * unitPrice;
  const discount = Math.min(grossTotal, Math.max(0, toNumber(form.elements.discountAmount?.value)));
  const total = Math.max(0, grossTotal - discount);
  const received = toNumber(form.elements.receivedAmount.value);
  if (form.elements.discountAmount && toNumber(form.elements.discountAmount.value) !== discount) {
    form.elements.discountAmount.value = discount;
  }
  form.elements.changeDue.value = yen.format(Math.max(0, received - total));
}

function recipeCost(product) {
  return product.recipe.reduce((sum, row) => {
    const part = state.parts.find((entry) => entry.id === row.partId);
    return sum + toNumber(part?.cost) * toNumber(row.qty);
  }, 0);
}

function productCost(product) {
  return toNumber(product.unitCost) || recipeCost(product);
}

function itemUnitCost(itemType, itemId) {
  if (itemType === "product") {
    const product = state.products.find((entry) => entry.id === itemId);
    return product ? productCost(product) : 0;
  }
  const part = state.parts.find((entry) => entry.id === itemId);
  return toNumber(part?.cost);
}

function eventSalesSummary(venueId) {
  const venue = state.venues.find((entry) => entry.id === venueId);
  const sales = state.sales.filter((sale) => saleIsActive(sale) && sale.venueId === venueId);
  const itemMap = new Map();
  let salesTotal = 0;
  let quantityTotal = 0;
  let costTotal = 0;

  sales.forEach((sale) => {
    const quantity = toNumber(sale.quantity);
    salesTotal += toNumber(sale.total);
    quantityTotal += quantity;
    costTotal += saleCost(sale);

    const key = `${sale.itemType}:${sale.itemId || sale.itemName}`;
    const current = itemMap.get(key) || {
      name: sale.itemName || "名称未設定",
      quantity: 0,
      total: 0,
    };
    current.quantity += quantity;
    current.total += toNumber(sale.total);
    itemMap.set(key, current);
  });

  const expenseTotal = (venue ? venueExpense(venue) : 0)
    + state.expenses.filter((expense) => expense.venueId === venueId)
      .reduce((sum, expense) => sum + toNumber(expense.amount), 0);
  const items = [...itemMap.values()].sort((a, b) => b.quantity - a.quantity);
  return {
    salesTotal,
    quantityTotal,
    costTotal,
    expenseTotal,
    profit: salesTotal - costTotal - expenseTotal,
    items,
    itemText: items.length ? items.map((item) => `${item.name} ${item.quantity}点`).join("、") : "販売記録なし",
  };
}

function saleCost(sale) {
  if (sale.costAtSale !== undefined) return toNumber(sale.costAtSale);
  const quantity = toNumber(sale.quantity);
  if (sale.unitCostAtSale !== undefined) return toNumber(sale.unitCostAtSale) * quantity;
  return itemUnitCost(sale.itemType, sale.itemId) * quantity;
}

function saleProfit(sale) {
  return toNumber(sale.total) - saleCost(sale);
}

function productionShortage(product, quantity) {
  if (!product.recipe.length) return ["使用部品が設定されていません"];
  return product.recipe.flatMap((row) => {
    const part = state.parts.find((entry) => entry.id === row.partId);
    const required = toNumber(row.qty) * quantity;
    const stock = toNumber(part?.stock);
    if (!part) return [`${partName(row.partId)}: 部品が見つかりません`];
    if (stock < required) return [`${part.name}: 必要 ${required}${part.unit} / 在庫 ${stock}${part.unit}`];
    return [];
  });
}

function maxBuildable(product) {
  if (!product.recipe?.length) return 0;
  return Math.max(0, Math.min(...product.recipe.map((row) => {
    const part = state.parts.find((entry) => entry.id === row.partId);
    const qty = toNumber(row.qty);
    if (!part || qty <= 0) return 0;
    return Math.floor(toNumber(part.stock) / qty);
  })));
}

function restoreSaleStock(sale) {
  const itemList = sale.itemType === "product" ? state.products : state.parts;
  const item = itemList.find((entry) => entry.id === sale.itemId);
  if (item) item.stock = toNumber(item.stock) + toNumber(sale.quantity);
}

function deleteVenueRelations(venueId) {
  const venue = state.venues.find((entry) => entry.id === venueId);
  const label = venue ? eventLabel(venue) : "削除済みイベント";
  if (venue) {
    const venueFees = [
      ["出展料", venue.boothFee],
      ["駐車場代", venue.parkingFee],
      ["交通費", venue.transportFee],
      ["その他費用", venue.otherFee],
    ];
    venueFees
      .filter(([, amount]) => toNumber(amount) > 0)
      .forEach(([category, amount]) => state.expenses.unshift(normalizeExpense({
        id: uid("expense"),
        date: venue.date,
        category: `${category}（削除イベントから移行）`,
        amount,
        venueId: "",
        venueLabel: label,
        memo: "イベント削除時に履歴へ移行",
      })));
  }
  state.sales
    .filter((sale) => sale.venueId === venueId)
    .forEach((sale) => {
      sale.venueLabel = sale.venueLabel || label;
      sale.venueId = "";
    });
  state.expenses
    .filter((expense) => expense.venueId === venueId)
    .forEach((expense) => {
      expense.venueLabel = expense.venueLabel || label;
      expense.venueId = "";
    });
}

function detachPartFromRecipes(partId) {
  state.products.forEach((product) => {
    const nextRecipe = (product.recipe || []).filter((row) => row.partId !== partId);
    if (nextRecipe.length === (product.recipe || []).length) return;
    product.recipe = nextRecipe;
    product.unitCost = recipeCost(product);
  });
}

function addRecipeRow(row = {}) {
  const template = document.getElementById("recipeTemplate").content.cloneNode(true);
  const wrapper = template.querySelector(".recipe-row");
  const select = wrapper.querySelector("select");
  const qty = wrapper.querySelector("input");
  select.innerHTML = optionList(state.parts, "部品なし");
  select.value = row.partId || "";
  qty.value = row.qty || 1;
  wrapper.querySelector("button").addEventListener("click", () => wrapper.remove());
  document.getElementById("recipeRows").appendChild(wrapper);
}

function readRecipeRows() {
  return [...document.querySelectorAll(".recipe-row")]
    .map((row) => ({
      partId: row.querySelector('[name="recipePart"]').value,
      qty: toNumber(row.querySelector('[name="recipeQty"]').value),
    }))
    .filter((row) => row.partId && row.qty > 0);
}

function editPart(id) {
  const part = state.parts.find((entry) => entry.id === id);
  if (!part) return;
  const form = document.getElementById("partForm");
  form.elements.id.value = part.id;
  form.elements.name.value = part.name;
  renderPartMasterOptions();
  form.elements.category.value = part.category || "";
  form.elements.kind.value = part.kind;
  form.elements.stock.value = part.stock;
  form.elements.minStock.value = part.minStock || 0;
  form.elements.unit.value = part.unit;
  form.elements.initialCost.value = part.initialCost ?? part.cost;
  form.elements.location.value = part.location;
  form.elements.supplier.value = part.supplier || "";
  form.elements.purchaseDate.value = part.initialPurchaseDate || part.purchaseDate || "";
  form.elements.barcode.value = part.barcode || "";
  form.elements.purchaseQty.value = 0;
  form.elements.purchaseCost.value = 0;
  form.elements.purchaseSupplier.value = part.supplier || "";
  form.elements.purchaseDateNew.value = new Date().toISOString().slice(0, 10);
  form.elements.memo.value = part.memo;
  form.elements.removeImage.value = "0";
  renderImagePreview(document.getElementById("partImagePreview"), [part.image], {
    actionLabel: "画像を削除",
    onRemove: () => {
      form.elements.removeImage.value = "1";
      form.elements.image.value = "";
      renderImagePreview(document.getElementById("partImagePreview"));
    },
  });
  renderPartAverageCost();
  openPartEditor();
}

function editProduct(id) {
  const product = state.products.find((entry) => entry.id === id);
  if (!product) return;
  const form = document.getElementById("productForm");
  form.elements.id.value = product.id;
  form.elements.name.value = product.name;
  form.elements.category.value = product.category || "";
  form.elements.stock.value = product.stock;
  form.elements.minStock.value = product.minStock || 0;
  form.elements.price.value = product.price;
  form.elements.barcode.value = product.barcode || "";
  form.elements.memo.value = product.memo;
  document.getElementById("recipeRows").innerHTML = "";
  product.recipe.forEach((row) => addRecipeRow(row));
  if (!product.recipe.length) addRecipeRow();
  form.elements.removeImage.value = "0";
  renderImagePreview(document.getElementById("productImagePreview"), [product.image], {
    actionLabel: "画像を削除",
    onRemove: () => {
      form.elements.removeImage.value = "1";
      form.elements.image.value = "";
      renderImagePreview(document.getElementById("productImagePreview"));
    },
  });
  openProductEditor();
}

function editVenue(id) {
  document.querySelector('.nav-item[data-view="venues"]').click();
  const venue = state.venues.find((entry) => entry.id === id);
  if (!venue) return;
  const form = document.getElementById("venueForm");
  form.elements.id.value = venue.id;
  form.elements.eventName.value = venue.eventName;
  form.elements.date.value = venue.date;
  form.elements.applicationDeadline.value = venue.applicationDeadline || "";
  form.elements.resultScheduledDate.value = venue.resultScheduledDate || "";
  form.elements.actualOperationDate.value = venue.actualOperationDate || "";
  form.elements.placeName.value = venue.placeName;
  form.elements.prefecture.value = venue.prefecture || "";
  form.elements.address.value = venue.address;
  form.elements.boothFee.value = venue.boothFee;
  form.elements.parkingFee.value = venue.parkingFee;
  form.elements.transportFee.value = venue.transportFee;
  form.elements.otherFee.value = venue.otherFee;
  form.elements.plannedProductQty.value = venue.plannedProductQty || 0;
  form.elements.cashFloat.value = venue.cashFloat || 0;
  form.elements.parkingLocation.value = venue.parkingLocation || "";
  form.elements.transportTrips.value = venue.transportTrips || 0;
  form.elements.fixtures.value = venue.fixtures || "";
  form.elements.review.value = venue.review || "";
  form.elements.customNotes.value = venue.customNotes || "";
  renderVenueCarryRows(venue.carriedProducts || []);
  renderVenuePlanRows(venue.plannedProducts || []);
  renderPrepChecklist(venue.prepChecklist?.length ? venue.prepChecklist : parsePrepItems(venue.prepItems));
  form.elements.prepItems.value = venue.prepItems || "";
  form.elements.memo.value = venue.memo;
  form.elements.removeImages.value = "[]";
  form.elements.replaceImages.checked = false;
  renderVenueSavedImages(form, venue.images || []);
  setVenuePageTab("record");
  openVenueEditor();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function makeProductFromCard(id) {
  document.querySelector('.nav-item[data-view="products"]').click();
  document.getElementById("productionProduct").value = id;
  document.querySelector("#productionForm [name=quantity]").value = 1;
  renderProductionPreview();
  openProductEditor();
  document.getElementById("productionForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function handleCatalogDrawerClick(event) {
  if (event.target.closest(".drawer-close")) {
    closeCatalogDrawer(event.currentTarget.id);
  }
}

function openCatalogDrawer(id, mode = "edit") {
  const drawer = document.getElementById(id);
  if (!drawer) return;
  drawer.dataset.mode = mode;
  drawer.classList.add("is-open");
  drawer.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
  const firstInput = drawer.querySelector("input:not([type=hidden]):not([type=file]), select, textarea");
  setTimeout(() => firstInput?.focus(), 80);
}

function closeCatalogDrawer(id) {
  const drawer = document.getElementById(id);
  if (!drawer) return;
  drawer.classList.remove("is-open");
  if (drawer.dataset.sectionPanelGroup) drawer.hidden = true;
  drawer.setAttribute("aria-hidden", "true");
}

function openPartEditor() {
  closeCatalogDrawer("productEditorDrawer");
  closeCatalogDrawer("productionDrawer");
  setSectionTab("parts", "edit");
  openCatalogDrawer("partEditorDrawer", "edit");
}

function openProductEditor() {
  closeCatalogDrawer("partEditorDrawer");
  closeCatalogDrawer("productionDrawer");
  setSectionTab("products", "edit");
  openCatalogDrawer("productEditorDrawer", "edit");
}

function editSale(id) {
  const sale = state.sales.find((entry) => entry.id === id);
  if (!sale || !saleIsActive(sale)) return;
  const form = document.getElementById("saleForm");
  form.elements.id.value = sale.id;
  form.elements.date.value = sale.date;
  form.elements.itemType.value = sale.itemType;
  renderSaleOptions();
  form.elements.venueId.value = sale.venueId;
  form.elements.itemId.value = sale.itemId;
  form.elements.quantity.value = sale.quantity;
  form.elements.unitPrice.value = sale.unitPrice;
  if (form.elements.discountAmount) form.elements.discountAmount.value = sale.discountAmount || 0;
  if (form.elements.discountReason) form.elements.discountReason.value = sale.discountReason || "";
  form.elements.paymentMethod.value = sale.paymentMethod || "cash";
  form.elements.receivedAmount.value = sale.receivedAmount || 0;
  form.elements.soldTime.value = sale.soldTime || "";
  form.elements.customerGender.value = sale.customerGender || "unknown";
  form.elements.customerAgeGroup.value = sale.customerAgeGroup || "unknown";
  form.elements.customerOrigin.value = sale.customerOrigin || "unknown";
  form.elements.customerRegion.value = sale.customerRegion || "unknown";
  syncCustomerRegionFields(form);
  renderSalePos();
  form.elements.memo.value = sale.memo;
  document.querySelector('.nav-item[data-view="sales"]').click();
  setSectionTab("sales", "edit");
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openSaleReturnEditor(id) {
  const sale = state.sales.find((entry) => entry.id === id);
  if (!sale || !saleIsActive(sale)) return;
  const overlay = document.createElement("div");
  overlay.className = "checkout-editor-backdrop";
  overlay.innerHTML = `
    <section class="checkout-editor" role="dialog" aria-modal="true" aria-labelledby="saleReturnTitle">
      <div class="panel-header"><div><p class="eyebrow">在庫・売上修正</p><h3 id="saleReturnTitle">一部返品を記録</h3></div><button type="button" class="icon-button" data-close-sale-return>×</button></div>
      <p>${escapeHtml(sale.itemName)} / 現在 ${sale.quantity}点 / 売上 ${yen.format(sale.total)}</p>
      <div class="checkout-editor-form">
        <label>返品数量<input name="returnQuantity" type="number" min="1" max="${sale.quantity}" step="1" value="1" /></label>
        <label>返金額（自動計算）<input name="returnAmount" type="text" readonly value="${yen.format(Math.round(sale.total / sale.quantity))}" /></label>
        <label>返品理由<textarea name="returnMemo" rows="2" placeholder="破損、交換、購入取り消しなど"></textarea></label>
      </div>
      <div class="form-actions"><button type="button" class="ghost-button" data-close-sale-return>キャンセル</button><button type="button" class="primary-button" data-save-sale-return>返品を記録</button></div>
    </section>`;
  document.body.appendChild(overlay);
  const form = overlay.querySelector(".checkout-editor-form");
  const quantityInput = form.elements.returnQuantity;
  const amountInput = form.elements.returnAmount;
  const updateAmount = () => { amountInput.value = yen.format(Math.round(sale.total * Math.min(sale.quantity, Math.max(1, toNumber(quantityInput.value))) / sale.quantity)); };
  quantityInput.addEventListener("input", updateAmount);
  const close = () => overlay.remove();
  overlay.querySelectorAll("[data-close-sale-return]").forEach((button) => button.addEventListener("click", close));
  overlay.querySelector("[data-save-sale-return]").addEventListener("click", () => {
    const quantity = Math.min(sale.quantity, Math.max(1, Math.floor(toNumber(quantityInput.value))));
    const refund = Math.round(sale.total * quantity / sale.quantity);
    sale.refundHistory = Array.isArray(sale.refundHistory) ? sale.refundHistory : [];
    sale.refundHistory.push({
      id: uid("refund"),
      at: new Date().toISOString(),
      quantity,
      amount: refund,
      reason: form.elements.returnMemo.value.trim(),
    });
    sale.refundAmount = toNumber(sale.refundAmount) + refund;
    const itemList = sale.itemType === "product" ? state.products : state.parts;
    const item = itemList.find((entry) => entry.id === sale.itemId);
    if (item) item.stock = toNumber(item.stock) + quantity;
    if (quantity >= sale.quantity) {
      sale.status = "cancelled";
      sale.cancelledAt = new Date().toISOString();
    } else {
      const remainingRatio = (sale.quantity - quantity) / sale.quantity;
      sale.quantity -= quantity;
      sale.total -= refund;
      sale.costAtSale = Math.round(toNumber(sale.costAtSale) * remainingRatio);
      sale.discountAmount = Math.round(toNumber(sale.discountAmount) * remainingRatio);
      sale.receivedAmount = 0;
      sale.changeDue = 0;
      sale.memo = `${sale.memo ? `${sale.memo} / ` : ""}返品 ${quantity}点${form.elements.returnMemo.value.trim() ? `: ${form.elements.returnMemo.value.trim()}` : ""}`;
    }
    if (!saveState({ action: "一部返品" })) return;
    close();
    renderAll();
    showToast(`返品 ${quantity}点を記録しました`);
  });
}

async function cancelSale(id) {
  const sale = state.sales.find((entry) => entry.id === id);
  if (!sale || !saleIsActive(sale)) return;
  const ok = await showConfirm("売上明細を取消しますか？", `${sale.itemName} ${sale.quantity}点を取消し、在庫へ戻します。物理削除はせず、履歴は取消済みとして残ります。`);
  if (!ok) return;
  restoreSaleStock(sale);
  sale.status = "cancelled";
  sale.cancelledAt = new Date().toISOString();
  if (!saveState({ action: "売上明細取消" })) return;
  renderAll();
  showToast("売上明細を取消しました。履歴は残っています。");
}

// reset イベントから呼ぶときは resetFields=false にして、reset の再発火による無限ループを防ぐ。
function clearPartForm(resetFields = true) {
  const form = document.getElementById("partForm");
  if (resetFields) form.reset();
  form.elements.id.value = "";
  form.elements.purchaseQty.value = 0;
  form.elements.purchaseCost.value = 0;
  form.elements.purchaseSupplier.value = "";
  form.elements.removeImage.value = "0";
  renderImagePreview(document.getElementById("partImagePreview"));
  renderPartAverageCost();
  setTodayDefaults();
}

function clearProductForm(resetFields = true) {
  const form = document.getElementById("productForm");
  if (resetFields) form.reset();
  form.elements.id.value = "";
  form.elements.removeImage.value = "0";
  document.getElementById("recipeRows").innerHTML = "";
  addRecipeRow();
  renderImagePreview(document.getElementById("productImagePreview"));
}

function clearVenueForm(resetFields = true) {
  const form = document.getElementById("venueForm");
  if (resetFields) form.reset();
  form.elements.id.value = "";
  form.elements.removeImages.value = "[]";
  form.elements.replaceImages.checked = false;
  renderImagePreview(document.getElementById("venueImagePreview"));
  renderVenueCarryRows();
  renderVenuePlanRows();
  renderPrepChecklist();
  setTodayDefaults();
}

function clearPurchaseForm(resetFields = true) {
  const form = document.getElementById("purchaseForm");
  if (!form) return;
  if (resetFields) form.reset();
  form.elements.id.value = "";
  form.elements.originalPartId.value = "";
  const lines = document.getElementById("purchaseLines");
  if (lines) {
    lines.innerHTML = "";
    addPurchaseLine();
  }
  setTodayDefaults();
  renderPurchaseOptions();
}

function clearSaleForm(resetFields = true) {
  const form = document.getElementById("saleForm");
  if (resetFields) form.reset();
  form.elements.id.value = "";
  setTodayDefaults();
  syncCustomerRegionFields(form);
  renderSaleOptions();
}

function bindListActions() {
  document.querySelectorAll("[data-open-venue]").forEach((button) => {
    button.onclick = () => updateVenueStatus(button.dataset.openVenue, "open");
  });
  document.querySelectorAll("[data-reopen-venue]").forEach((button) => {
    button.onclick = () => updateVenueStatus(button.dataset.reopenVenue, "open");
  });
  document.querySelectorAll("[data-select-workflow-venue]").forEach((button) => {
    button.onclick = () => {
      const select = document.getElementById("eventWorkflowEvent");
      if (select) {
        select.value = button.dataset.selectWorkflowVenue;
        renderEventWorkflow();
        document.getElementById("eventWorkflowPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
  });
  document.querySelectorAll("[data-edit-part]").forEach((button) => button.onclick = () => editPart(button.dataset.editPart));
  document.querySelectorAll("[data-purchase-part]").forEach((button) => button.onclick = () => openPurchaseForPart(button.dataset.purchasePart));
  document.querySelectorAll("[data-edit-product]").forEach((button) => button.onclick = () => editProduct(button.dataset.editProduct));
  document.querySelectorAll("[data-edit-venue]").forEach((button) => button.onclick = () => editVenue(button.dataset.editVenue));
  document.querySelectorAll("[data-make-product]").forEach((button) => button.onclick = () => makeProductFromCard(button.dataset.makeProduct));
  document.querySelectorAll("[data-edit-sale]").forEach((button) => button.onclick = () => editSale(button.dataset.editSale));
  document.querySelectorAll("[data-edit-checkout]").forEach((button) => {
    button.onclick = () => editCheckout(button.dataset.editCheckout);
  });
  document.querySelectorAll("[data-cancel-sale]").forEach((button) => button.onclick = () => cancelSale(button.dataset.cancelSale));
  document.querySelectorAll("[data-cancel-sale]").forEach((button) => {
    button.textContent = "明細を取消";
    button.title = "この売上明細を取消し、在庫へ戻します。履歴は残ります。";
  });
  document.querySelectorAll("[data-cancel-sale]").forEach((button) => {
    const actions = button.closest(".tile-actions");
    if (!actions || actions.querySelector(`[data-return-sale="${button.dataset.cancelSale}"]`)) return;
    const returnButton = document.createElement("button");
    returnButton.type = "button";
    returnButton.className = "ghost-button";
    returnButton.dataset.returnSale = button.dataset.cancelSale;
    returnButton.textContent = "一部返品";
    returnButton.onclick = () => openSaleReturnEditor(button.dataset.cancelSale);
    actions.insertBefore(returnButton, button);
  });
  document.querySelectorAll("[data-print-sale]").forEach((button) => button.onclick = () => {
    const sale = state.sales.find((entry) => entry.id === button.dataset.printSale);
    if (sale) printReceipt(sale);
  });
  bindDelete("[data-delete-part]", state.parts, "deletePart");
  bindDelete("[data-delete-product]", state.products, "deleteProduct");
  bindDelete("[data-delete-venue]", state.venues, "deleteVenue");
  bindDelete("[data-delete-sale]", state.sales, "deleteSale");
  bindDelete("[data-delete-expense]", state.expenses, "deleteExpense");
}

function openPurchaseForPart(id) {
  const nav = document.querySelector('.nav-item[data-view="purchases"]');
  const form = document.getElementById("purchaseForm");
  if (!state.parts.some((entry) => entry.id === id) || !nav || !form) return;
  pendingPurchasePartId = id;
  nav.click();
  setSectionTab("purchases", "edit");
  setTimeout(() => {
    clearPurchaseForm();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    form.querySelector('[name="qty"]')?.focus();
  }, 0);
}

function bindDelete(selector, collection, dataName) {
  document.querySelectorAll(selector).forEach((button) => {
    button.onclick = async () => {
      const id = button.dataset[dataName];
      const index = collection.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      let confirmedRelated = false;
      if (dataName === "deletePart" || dataName === "deleteProduct") {
        const relatedRecipes = dataName === "deletePart"
          ? state.products.filter((product) => product.recipe?.some((row) => row.partId === id)).length
          : 0;
        const relatedSales = state.sales.filter((sale) => sale.itemId === id).length;
        if (relatedRecipes || relatedSales) {
          const relatedMessage = `${relatedRecipes ? `レシピ参照 ${relatedRecipes}商品` : ""}${relatedRecipes && relatedSales ? "、" : ""}${relatedSales ? `販売履歴 ${relatedSales}件` : ""}があります。削除すると関連表示に影響します。`;
          confirmedRelated = await showConfirm("関連データがあります", relatedMessage);
          if (!confirmedRelated) return;
        }
      }
      const message = dataName === "deleteVenue"
        ? `イベントだけを削除し、紐づく販売 ${state.sales.filter((sale) => sale.venueId === id).length}件・費用 ${state.expenses.filter((expense) => expense.venueId === id).length}件は履歴として残します。`
        : `${collection[index].name || "選択したデータ"}を削除します。現在庫 ${collection[index].stock || 0} と関連履歴に影響する場合があります。`;
      const ok = await showConfirm("削除しますか？", message);
      if (!ok) return;
      if (dataName === "deletePart") {
        state.archivedParts = Array.isArray(state.archivedParts) ? state.archivedParts : [];
        state.archivedParts.unshift({ ...collection[index], archivedAt: new Date().toISOString() });
      }
      if (dataName === "deleteProduct") {
        state.archivedProducts = Array.isArray(state.archivedProducts) ? state.archivedProducts : [];
        state.archivedProducts.unshift({ ...collection[index], archivedAt: new Date().toISOString() });
      }
      if (dataName === "deletePart" && confirmedRelated) detachPartFromRecipes(id);
      if (dataName === "deleteSale" && saleIsActive(collection[index])) restoreSaleStock(collection[index]);
      if (dataName === "deleteVenue") deleteVenueRelations(id);
      collection.splice(index, 1);
      if (!saveState()) return;
      renderAll();
      showToast("削除しました");
    };
  });
}

function optionList(items, emptyLabel, labeler = (item) => item.name) {
  if (!items.length) return `<option value="">${emptyLabel}</option>`;
  return items.map((item) => `<option value="${item.id}">${escapeHtml(labeler(item))}</option>`).join("");
}

function partName(id) {
  return state.parts.find((part) => part.id === id)?.name || "削除済み部品";
}

function venueName(id) {
  const venue = state.venues.find((entry) => entry.id === id);
  return venue ? eventLabel(venue) : "出展イベント未設定";
}

function saleVenueName(sale) {
  return sale.venueLabel || venueName(sale.venueId);
}

function paymentMethodLabel(value) {
  return value === "cashless" ? "キャッシュレス" : "現金";
}

function eventLabel(venue) {
  return `${venue.date ? `${venue.date} ` : ""}${venue.eventName}${venue.placeName ? `（${venue.placeName}）` : ""}`;
}

function venueExpense(venue) {
  return toNumber(venue.boothFee) + toNumber(venue.parkingFee) + toNumber(venue.transportFee) + toNumber(venue.otherFee);
}

function totalEventExpenses() {
  return state.venues.reduce((sum, venue) => sum + venueExpense(venue), 0);
}

function legacyExpenseTotal() {
  return state.expenses.reduce((sum, expense) => sum + toNumber(expense.amount), 0);
}

function imageOrPlaceholder(image, label, className) {
  if (image) return `<img class="${className}" src="${image}" alt="${escapeHtml(label)}">`;
  return `<div class="${className} image-placeholder">画像</div>`;
}

function rowItem(title, body, action = "") {
  return `
    <article class="row-item">
      <div>
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(body)}</p>
      </div>
      ${action ? `<div class="tile-actions">${action}</div>` : ""}
    </article>`;
}

function fillList(id, nodes, emptyText) {
  const node = document.getElementById(id);
  if (!node) return;
  if (nodes.length) {
    node.innerHTML = nodes.join("");
    return;
  }
  const actions = {
    partList: ["parts", "部品を登録する"],
    productList: ["products", "商品を登録する"],
    venueList: ["venues", "イベントを登録する"],
    purchaseList: ["purchases", "仕入を登録する"],
    saleList: ["sales", "販売を登録する"],
  }[id];
  node.innerHTML = `<div class="empty-note"><p>${emptyText}</p>${actions ? `<button class="ghost-button" type="button" data-empty-jump="${actions[0]}">${actions[1]}</button>` : ""}</div>`;
  node.querySelector("[data-empty-jump]")?.addEventListener("click", () => {
    document.querySelector(`.nav-item[data-view="${actions[0]}"]`)?.click();
  });
}

function renderProductionPreview() {
  const product = state.products.find((entry) => entry.id === document.getElementById("productionProduct").value);
  const quantity = Math.floor(toNumber(document.querySelector("#productionForm [name=quantity]").value));
  const preview = document.getElementById("productionPreview");
  if (!product) {
    preview.className = "production-preview empty-note";
    preview.textContent = "商品を選択してください";
    return;
  }
  if (!product.recipe.length) {
    preview.className = "production-preview empty-note";
    preview.textContent = "この商品には使用部品が設定されていません";
    return;
  }
  const rows = product.recipe.map((row) => {
    const part = state.parts.find((entry) => entry.id === row.partId);
    const required = toNumber(row.qty) * Math.max(quantity, 0);
    const stock = toNumber(part?.stock);
    const after = stock - required;
    const unit = part?.unit || "";
    const short = stock < required;
    return `<li class="production-material-row ${short ? "short" : ""}">
      <strong>${escapeHtml(part?.name || "削除済み部品")}</strong>
      <span>現在庫 <b>${stock}${escapeHtml(unit)}</b></span>
      <span>使用 <b>-${required}${escapeHtml(unit)}</b></span>
      <span class="production-after">製作後 <b>${after}${escapeHtml(unit)}</b></span>
    </li>`;
  });
  const unitCost = recipeCost(product);
  const totalCost = unitCost * Math.max(quantity, 0);
  preview.className = `production-preview ${productionShortage(product, quantity).length ? "has-shortage" : ""}`;
  preview.innerHTML = `
    <div class="production-cost-preview">
      <span>製作後の材料状況</span>
      <strong>${Math.max(quantity, 0)}個を製作</strong>
      <em>原価目安 ${yen.format(totalCost)}</em>
    </div>
    <ul>${rows.join("")}</ul>
  `;
}

function writeAutoBackup() {
  const snapshot = {
    id: uid("backup"),
    savedAt: new Date().toISOString(),
    data: JSON.parse(JSON.stringify(state)),
  };
  if (storageBackend === "indexeddb") {
    // 画像は images ストアに1枚だけ保存し、バックアップには参照だけを持たせる。
    snapshot.data = extractImages(snapshot.data, pendingImages);
    backupsCache = [snapshot, ...backupsCache].slice(0, MAX_BACKUPS);
    scheduleDatabaseWrite();
    return true;
  }
  const backups = [snapshot, ...backupsCache];
  for (let limit = MAX_BACKUPS; limit >= 1; limit -= 1) {
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(backups.slice(0, limit)));
      backupsCache = backups.slice(0, limit);
      return true;
    } catch (error) {
      console.warn(`自動バックアップ${limit}世代の保存に失敗しました`, error);
    }
  }
  try {
    localStorage.removeItem(BACKUP_KEY);
    backupsCache = [];
  } catch (error) {
    console.warn("自動バックアップを削除できませんでした", error);
  }
  showToast("本体データは保存しましたが、自動バックアップを保存できませんでした。");
  return false;
}

function readBackups() {
  return backupsCache;
}

function validBackups(list) {
  return Array.isArray(list)
    ? list.filter((backup) => backup && typeof backup === "object" && backup.data && typeof backup.data === "object")
    : [];
}

// 復元用に、参照になっている画像を差し戻したバックアップ内容を返す。
async function backupData(backup) {
  if (storageBackend !== "indexeddb") return backup.data;
  const ids = new Set();
  collectImageRefs(backup.data, ids);
  return injectImages(backup.data, await loadImages(ids));
}

function renderBackupStatus() {
  const nodes = [...document.querySelectorAll("#backupStatus, #dataBackupStatus")];
  if (!nodes.length) return;
  const backups = readBackups();
  const latest = backups[0];
  const html = `
    <div><span>保存履歴</span><strong>${backups.length}件</strong></div>
    <div><span>最新</span><strong>${latest ? formatDateTime(latest.savedAt) : "未作成"}</strong></div>
    <div><span>保持数</span><strong>最大10件</strong></div>
  `;
  nodes.forEach((node) => { node.innerHTML = html; });
}

async function restoreLatestBackup() {
  const backups = readBackups();
  if (!backups.length) {
    await showMessage("復元できません", "バックアップ履歴がまだありません。");
    return;
  }
  const latest = backups[0];
  const ok = await showConfirm("バックアップを復元しますか？", `${formatDateTime(latest.savedAt)} の状態に戻します。現在の状態は復元前に自動バックアップされます。`);
  if (!ok) return;
  try {
    const data = await backupData(latest);
    writeAutoBackup();
    Object.assign(state, normalizeImportedState(data));
    if (!saveState()) return;
  } catch (error) {
    console.error(error);
    showToast("バックアップの内容を確認できないため復元できませんでした。");
    return;
  }
  renderAll();
  showToast("バックアップを復元しました");
}

function normalizeImportedState(imported) {
  if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
    throw new Error("データ形式が不正です");
  }
  if (imported.parts !== undefined && !Array.isArray(imported.parts)) throw new Error("部品データが不正です");
  if (imported.products !== undefined && !Array.isArray(imported.products)) throw new Error("商品データが不正です");
  if (imported.venues !== undefined && !Array.isArray(imported.venues)) throw new Error("イベントデータが不正です");
  if (imported.sales !== undefined && !Array.isArray(imported.sales)) throw new Error("販売データが不正です");
  if (imported.expenses !== undefined && !Array.isArray(imported.expenses)) throw new Error("費用データが不正です");
  const parts = (imported.parts || []).map(normalizePart);
  return {
    parts,
    masters: normalizeMasters(imported.masters, parts),
    products: (imported.products || []).map(normalizeProduct),
    archivedParts: Array.isArray(imported.archivedParts) ? imported.archivedParts.map(normalizePart) : [],
    archivedProducts: Array.isArray(imported.archivedProducts) ? imported.archivedProducts.map(normalizeProduct) : [],
    venues: (imported.venues || []).map(normalizeVenue),
    sales: (imported.sales || []).map(normalizeSale),
    expenses: (imported.expenses || []).map(normalizeExpense),
    stockAdjustments: Array.isArray(imported.stockAdjustments) ? imported.stockAdjustments : [],
    operationLogs: Array.isArray(imported.operationLogs) ? imported.operationLogs : [],
    users: Array.isArray(imported.users) && imported.users.length
      ? imported.users.map((user) => ({ ...user, role: "admin" }))
      : [{ id: "owner", name: "管理者", role: "admin" }],
  };
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `marche-stock-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("JSONを書き出しました");
}

function importJson(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = JSON.parse(reader.result);
      const nextState = normalizeImportedState(imported);
      const ok = await showConfirm("JSONを取り込みますか？", "現在のデータをバックアップしたうえで、読み込んだデータに置き換えます。");
      if (!ok) return;
      writeAutoBackup();
      Object.assign(state, nextState);
      if (!saveState()) return;
      renderAll();
      showToast("JSONを読み込みました");
    } catch {
      await showMessage("読み込みできません", "JSONファイルの形式を確認してください。");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

function showToast(message) {
  const stack = document.getElementById("toastStack");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    setTimeout(() => toast.remove(), 180);
  }, 2400);
}

function showMessage(title, message) {
  return showModal(title, message, [{ label: "閉じる", value: true, className: "primary-button" }]);
}

function showConfirm(title, message) {
  return showModal(title, message, [
    { label: "キャンセル", value: false, className: "ghost-button" },
    { label: "実行", value: true, className: "danger-button" },
  ]);
}

function showModal(title, message, actions) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById("modalBackdrop");
    const titleNode = document.getElementById("modalTitle");
    const messageNode = document.getElementById("modalMessage");
    const actionsNode = document.getElementById("modalActions");
    titleNode.textContent = title;
    messageNode.textContent = message;
    actionsNode.innerHTML = "";

    const close = (value) => {
      backdrop.classList.remove("show");
      backdrop.setAttribute("aria-hidden", "true");
      resolve(value);
    };

    actions.forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.className;
      button.textContent = action.label;
      button.addEventListener("click", () => close(action.value));
      actionsNode.appendChild(button);
    });

    backdrop.classList.add("show");
    backdrop.setAttribute("aria-hidden", "false");
    actionsNode.querySelector("button")?.focus();
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
