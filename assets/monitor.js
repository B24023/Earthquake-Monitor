const find = id => document.getElementById(id);
const canvas = find("map");
const context = canvas.getContext("2d");
const nationalView = { west: 121, east: 151, south: 22, north: 48 };
const intensityColors = new Map([
    ["1", "#316d83"], ["2", "#14786d"], ["3", "#3c751b"], ["4", "#8b610a"],
    ["5-", "#ad480c"], ["5+", "#b43220"], ["6-", "#a52a53"], ["6+", "#80316a"], ["7", "#5c327d"]
]);
const intensityOrder = [...intensityColors.keys()];
const japaneseTime = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

let land = [];
let mapFailed = false;
let catalog = [];
let currentEvent = null;
let currentDetails = null;
let view = nationalView;
let markers = [];
let followsLatest = true;
let detailRequest = 0;
const refreshIntervalMs = 30_000;
let refreshTimer;
let refreshing = false;

function intensityText(value) {
    return value?.replace("-", "弱").replace("+", "強") || "—";
}

function setIntensity(element, value) {
    element.dataset.level = value || "";
    element.textContent = intensityText(value);
}

function formatTime(value) {
    const stamp = Date.parse(value);
    return Number.isFinite(stamp) ? japaneseTime.format(stamp) : "—";
}

function updateTime(element, value) {
    element.dateTime = value || "";
    element.textContent = formatTime(value);
}

async function json(url) {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function drawMap() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const pixelRatio = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const lonCenter = (view.west + view.east) / 2;
    const latCenter = (view.south + view.north) / 2;
    const longitudeScale = Math.cos(latCenter * Math.PI / 180);
    const scale = Math.min((width - 36) / ((view.east - view.west) * longitudeScale),
        (height - 36) / (view.north - view.south));
    const x = lon => width / 2 + (lon - lonCenter) * longitudeScale * scale;
    const y = lat => height / 2 - (lat - latCenter) * scale;
    context.fillStyle = "#102b38";
    context.fillRect(0, 0, width, height);

    context.lineWidth = 1;
    context.strokeStyle = "#294653";
    context.fillStyle = "#a9c1c5";
    context.font = "11px system-ui";
    const step = view.east - view.west <= 10 ? 1 : 5;
    for (let lon = Math.ceil(view.west / step) * step; lon <= view.east; lon += step) {
        context.beginPath();
        context.moveTo(x(lon), 0);
        context.lineTo(x(lon), height);
        context.stroke();
        context.fillText(`${lon}°E`, x(lon) + 4, height - 9);
    }
    for (let lat = Math.ceil(view.south / step) * step; lat <= view.north; lat += step) {
        context.beginPath();
        context.moveTo(0, y(lat));
        context.lineTo(width, y(lat));
        context.stroke();
        context.fillText(`${lat}°N`, 7, y(lat) - 4);
    }

    context.strokeStyle = "#6c9894";
    context.fillStyle = "#315658";
    for (const polygon of land) {
        context.beginPath();
        for (const ring of polygon) {
            context.moveTo(x(ring[0][0]), y(ring[0][1]));
            for (let index = 1; index < ring.length; index++) {
                const [lon, lat] = ring[index];
                context.lineTo(x(lon), y(lat));
            }
            context.closePath();
        }
        context.fill("evenodd");
        context.stroke();
    }

    markers = (currentDetails?.stations || [])
        .filter(point => point.lat !== null && point.lon !== null && intensityColors.has(point.intensity))
        .sort((a, b) => intensityOrder.indexOf(a.intensity) - intensityOrder.indexOf(b.intensity))
        .map(point => ({ ...point, x: x(point.lon), y: y(point.lat) }));
    for (const marker of markers) {
        context.beginPath();
        const strong = intensityOrder.indexOf(marker.intensity) >= 3;
        context.arc(marker.x, marker.y, strong ? 7 : 5, 0, 2 * Math.PI);
        context.fillStyle = intensityColors.get(marker.intensity);
        context.fill();
        context.strokeStyle = "#f5faf4";
        context.stroke();
    }
    if (currentEvent?.epicenter) {
        const { lon, lat } = currentEvent.epicenter;
        const px = x(lon), py = y(lat);
        context.beginPath();
        context.moveTo(px - 7, py - 7);
        context.lineTo(px + 7, py + 7);
        context.moveTo(px + 7, py - 7);
        context.lineTo(px - 7, py + 7);
        context.lineCap = "round";
        context.lineWidth = 4;
        context.strokeStyle = "#102b38";
        context.stroke();
        context.lineWidth = 2;
        context.strokeStyle = "#ffa276";
        context.stroke();
    }
}

function mapNote() {
    if (mapFailed) return "背景地図を取得できません。観測震度は下の一覧で確認できます。";
    if (!currentDetails) return "観測点の情報を待っています。";
    if (!markers.length) return "この発表で地図に表示できる観測点はありません。";
    const extra = currentDetails.stations.length - markers.length;
    return `地図に ${markers.length} 地点を表示${extra ? `（一覧のみ ${extra} 地点）` : ""}。点を選ぶと観測点名と震度を確認できます。`;
}

function renderEvents() {
    const items = catalog.map(event => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        const badge = document.createElement("span");
        const info = document.createElement("span");
        const name = document.createElement("strong");
        const time = document.createElement("time");
        button.type = "button";
        button.className = "event-button";
        button.dataset.event = event.id;
        badge.className = "intensity";
        setIntensity(badge, event.maximum);
        name.textContent = event.name;
        updateTime(time, event.occurredAt || event.reportedAt);
        info.append(name, time);
        button.append(badge, info);
        button.addEventListener("click", () => {
            followsLatest = event.id === catalog[0]?.id;
            selectEvent(event);
        });
        item.append(button);
        return item;
    });
    find("events").replaceChildren(...items);
    find("empty-events").hidden = items.length > 0;
    syncSelection();
}

function syncSelection() {
    for (const button of find("events").querySelectorAll("button")) {
        button.setAttribute("aria-current", String(button.dataset.event === currentEvent?.id));
    }
    find("latest").hidden = followsLatest || !catalog.length;
}

function renderObservations() {
    const search = find("search").value.trim().normalize("NFKC");
    const stations = currentDetails?.stations || [];
    const observations = stations.length ? stations : currentDetails?.areas || [];
    const matches = observations.filter(point => point.name.normalize("NFKC").includes(search))
        .sort((a, b) => intensityOrder.indexOf(b.intensity) - intensityOrder.indexOf(a.intensity));
    const rows = matches.map(point => {
        const row = document.createElement("tr");
        const name = document.createElement("td");
        const intensity = document.createElement("td");
        name.textContent = point.name;
        if (point.intensity) {
            const badge = document.createElement("span");
            badge.className = "intensity";
            setIntensity(badge, point.intensity);
            intensity.append(badge);
        } else {
            intensity.textContent = "未入電";
        }
        row.append(name, intensity);
        return row;
    });
    find("observations").replaceChildren(...rows);
    find("search-box").hidden = !observations.length;
    find("observation-table").hidden = !rows.length;
    const note = find("observation-note");
    note.hidden = rows.length > 0;
    note.textContent = observations.length ? "一致する地点・地域がありません。" : "この発表に地点別の観測震度はありません。";
    find("report-time").textContent = currentEvent
        ? `${formatTime(currentEvent.reportedAt)} 発表${observations.length && !stations.length ? " · 地域別最大震度" : ""}`
        : "";
}

function renderSummary(event) {
    setIntensity(find("maximum"), event?.maximum);
    find("event-name").textContent = event?.name || "表示できる地震情報がありません";
    find("report-kind").textContent = event?.kind || "";
    find("origin").textContent = formatTime(event?.occurredAt);
    find("magnitude").textContent = event?.magnitude || "—";
    find("depth").textContent = event?.depth === 0 ? "ごく浅い" : event?.depth == null ? "—" : `${event.depth} km`;
    find("focus").disabled = !event?.epicenter && !markers.length;
}

async function selectEvent(event) {
    if (event.id !== currentEvent?.id) {
        view = nationalView;
        find("search").value = "";
    }
    const request = ++detailRequest;
    currentEvent = event;
    currentDetails = null;
    syncSelection();
    drawMap();
    renderSummary(event);
    renderObservations();
    find("observation-note").textContent = "観測震度を読み込んでいます。";
    find("map-note").textContent = mapNote();
    try {
        const detail = await json(`/api/earthquakes/${event.id}`);
        if (request !== detailRequest) return;
        currentEvent = detail.event;
        currentDetails = detail;
        drawMap();
        renderSummary(detail.event);
        renderObservations();
        find("map-note").textContent = mapNote();
    } catch {
        if (request !== detailRequest) return;
        find("observation-note").textContent = "観測震度を取得できません。次回の更新時に再取得します。";
    }
}

async function refresh() {
    if (refreshing) return;
    refreshing = true;
    window.clearTimeout(refreshTimer);
    let refreshAt = performance.now() + refreshIntervalMs;
    try {
        const data = await json("/api/earthquakes");
        if (Number.isFinite(data.refreshAfterMs)) {
            refreshAt = performance.now() + Math.min(refreshIntervalMs, data.refreshAfterMs + 1);
        }
        const status = find("feed-status");
        status.dataset.state = data.stale ? "stale" : "ready";
        status.textContent = data.stale ? "一覧の更新が停止しています" : "地震情報を取得済み";
        find("last-checked").textContent = `最終取得 ${formatTime(data.checkedAt)} JST`;
        const newCatalog = data.events;
        if (JSON.stringify(newCatalog.map(item => item.revision)) !== JSON.stringify(catalog.map(item => item.revision))) {
            catalog = newCatalog;
            renderEvents();
        }
        if (!catalog.length) {
            ++detailRequest;
            currentEvent = null;
            currentDetails = null;
            view = nationalView;
            find("empty-events").hidden = false;
            find("empty-events").textContent = "配信一覧に地震情報がありません。";
            drawMap();
            renderSummary(null);
            renderObservations();
            find("map-note").textContent = mapNote();
            return;
        }
        const selected = followsLatest ? catalog[0] : catalog.find(event => event.id === currentEvent?.id);
        if (!selected) followsLatest = true;
        const target = selected || catalog[0];
        if (target.revision !== currentEvent?.revision || !currentDetails) void selectEvent(target);
    } catch {
        const status = find("feed-status");
        status.dataset.state = "stale";
        status.textContent = catalog.length ? "一覧の更新が停止しています" : "地震情報を取得できません";
        find("empty-events").textContent = "取得できませんでした。自動で再接続します。";
    } finally {
        refreshing = false;
        refreshTimer = window.setTimeout(refresh, Math.max(250, refreshAt - performance.now()));
    }
}

for (const intensity of intensityOrder) {
    const item = document.createElement("li");
    item.className = "intensity";
    setIntensity(item, intensity);
    find("legend").append(item);
}
find("latest").addEventListener("click", () => {
    followsLatest = true;
    selectEvent(catalog[0]);
});
find("national").addEventListener("click", () => {
    view = nationalView;
    drawMap();
});
find("focus").addEventListener("click", () => {
    const points = [...markers];
    if (currentEvent?.epicenter) points.push(currentEvent.epicenter);
    if (!points.length) return;
    const lons = points.map(point => point.lon);
    const lats = points.map(point => point.lat);
    const middleLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const middleLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const width = Math.max(2, (Math.max(...lons) - Math.min(...lons)) * 1.25);
    const height = Math.max(1.6, (Math.max(...lats) - Math.min(...lats)) * 1.25);
    view = { west: middleLon - width / 2, east: middleLon + width / 2,
        south: middleLat - height / 2, north: middleLat + height / 2 };
    drawMap();
});
canvas.addEventListener("click", event => {
    const bounds = canvas.getBoundingClientRect();
    let nearest;
    let distance = 13;
    for (const marker of markers) {
        const against = Math.hypot(marker.x - (event.clientX - bounds.left), marker.y - (event.clientY - bounds.top));
        if (against <= distance) {
            distance = against;
            nearest = marker;
        }
    }
    find("map-note").textContent = nearest
        ? `${nearest.name} · 震度 ${intensityText(nearest.intensity)}`
        : mapNote();
});
find("search").addEventListener("input", renderObservations);
new ResizeObserver(drawMap).observe(canvas);
json("/assets/land.json").then(data => {
    land = data;
    drawMap();
}).catch(() => {
    mapFailed = true;
    find("map-note").textContent = mapNote();
});
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
});
refresh();
