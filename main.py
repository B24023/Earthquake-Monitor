import asyncio
import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent
JMA_FEED = "https://www.jma.go.jp/bosai/quake/data/"
LIST_REFRESH_SECONDS = 60
EVENT_LIMIT = 24
INTENSITIES = ("1", "2", "3", "4", "5-", "5+", "6-", "6+", "7")
REPORT_TITLES = {"震度速報", "震源・震度情報", "震源・震度に関する情報", "各地の震度に関する情報"}
EVENT_ID = re.compile(r"[0-9]{14}")
REPORT_NAME = re.compile(r"[0-9]{14}_[0-9]{14}_[A-Za-z0-9]+_[0-9]+\.json")
COORDINATE = re.compile(r"([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+)?/")
logger = logging.getLogger(__name__)


def epicenter(value):
    match = COORDINATE.fullmatch(value or "")
    if match is None:
        return None, None
    lat, lon, depth = match.groups()
    return {"lat": float(lat), "lon": float(lon)}, -int(depth) / 1000 if depth else None


def catalog_entries(rows):
    if not isinstance(rows, list):
        raise ValueError("Expected an earthquake catalog")
    entries = {}
    for row in sorted(rows, key=lambda item: item.get("rdt", ""), reverse=True):
        event_id = row.get("eid")
        if row.get("ttl") not in REPORT_TITLES or not EVENT_ID.fullmatch(event_id or ""):
            continue
        if event_id in entries:
            continue
        if row.get("ift") == "取消":
            entries[event_id] = None
            continue
        name = row.get("json")
        if not REPORT_NAME.fullmatch(name or "") or row.get("maxi") not in INTENSITIES:
            continue
        point, depth = epicenter(row.get("cod"))
        entries[event_id] = {
            "id": event_id, "name": row.get("anm") or "震源情報の発表待ち",
            "occurredAt": row.get("at") or None, "reportedAt": row["rdt"],
            "magnitude": row.get("mag") or None, "depth": depth, "epicenter": point,
            "maximum": row["maxi"], "kind": row["ttl"], "revision": name,
        }
    events = [entry for entry in entries.values() if entry is not None]
    return sorted(events, key=lambda entry: entry["occurredAt"] or entry["reportedAt"], reverse=True)[:EVENT_LIMIT]


def observations(report, event_id):
    head = report["Head"]
    if head["EventID"] != event_id or head.get("InfoType") == "取消":
        raise ValueError("The report does not match the selected earthquake")
    observation = report["Body"]["Intensity"]["Observation"]
    stations = {}
    areas = []
    for prefecture in observation.get("Pref", []):
        for area in prefecture.get("Area", []):
            areas.append({"name": area["Name"], "intensity": area.get("MaxInt")})
            for city in area.get("City", []):
                for station in city.get("IntensityStation", []):
                    point = station.get("latlon") or {}
                    lat, lon = point.get("lat"), point.get("lon")
                    if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float))
                            and -90 <= lat <= 90 and -180 <= lon <= 180):
                        lat, lon = None, None
                    code = station["Code"]
                    intensity = station.get("Int")
                    stations[code] = {
                        "id": code, "name": station["Name"], "intensity": intensity if intensity in INTENSITIES else None,
                        "lat": lat, "lon": lon,
                    }
    return {"stations": list(stations.values()), "areas": areas}


class QuakeFeed:
    def __init__(self, client):
        self.client = client
        self.catalog_lock = asyncio.Lock()
        self.detail_lock = asyncio.Lock()
        self.events = []
        self.details = {}
        self.checked_at = None
        self.next_check = 0
        self.stale = True

    async def read(self, filename):
        response = await self.client.get(filename)
        response.raise_for_status()
        return response.json()

    async def catalog(self):
        async with self.catalog_lock:
            if monotonic() >= self.next_check:
                try:
                    self.events = catalog_entries(await self.read("list.json"))
                    revisions = {event["revision"] for event in self.events}
                    self.details = {key: value for key, value in self.details.items() if key in revisions}
                    self.checked_at = datetime.now(timezone.utc).isoformat()
                    self.stale = False
                except (httpx.HTTPError, AttributeError, KeyError, TypeError, ValueError) as error:
                    logger.warning("JMA earthquake catalog unavailable: %s", error)
                    self.stale = True
                self.next_check = monotonic() + (30 if self.stale else LIST_REFRESH_SECONDS)
            if self.checked_at is None:
                raise HTTPException(503, "気象庁の地震情報を取得できません。")
            return {"events": self.events, "checkedAt": self.checked_at, "stale": self.stale}

    async def detail(self, event):
        revision = event["revision"]
        async with self.detail_lock:
            if revision not in self.details:
                try:
                    self.details[revision] = observations(await self.read(revision), event["id"])
                except (httpx.HTTPError, AttributeError, KeyError, TypeError, ValueError) as error:
                    logger.warning("JMA earthquake report unavailable: %s", error)
                    raise HTTPException(502, "この地震の観測情報を取得できません。") from error
            return self.details[revision]


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(base_url=JMA_FEED, timeout=7.0) as client:
        app.state.feed = QuakeFeed(client)
        yield


app = FastAPI(title="地震観測モニタ", lifespan=lifespan)
app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="assets")


@app.get("/", response_class=FileResponse)
async def monitor():
    return FileResponse(ROOT / "index.html", media_type="text/html")


@app.get("/earthquake", include_in_schema=False)
async def earthquake():
    return RedirectResponse("/")


@app.get("/api/earthquakes")
async def earthquakes(request: Request):
    return await request.app.state.feed.catalog()


@app.get("/api/earthquakes/{event_id}")
async def earthquake_observations(event_id: str, request: Request):
    feed = request.app.state.feed
    if not EVENT_ID.fullmatch(event_id):
        raise HTTPException(404)
    catalog = await feed.catalog()
    event = next((entry for entry in catalog["events"] if entry["id"] == event_id), None)
    if event is None:
        raise HTTPException(404)
    return {"event": event, **await feed.detail(event)}
