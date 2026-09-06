import fs from 'fs/promises';
import path from 'path';

// Pomožna funkcija za izračun razdalje v metrih (Haversine formula)
function getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Pametni normalizator imen (100% varen)
function normalizeName(name) {
  if (!name) return "";
  let n = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); 
  
  // 1. Odstranimo vse za poševnico
  n = n.replace(/\/.*/, "");
  // 2. Odstranimo vse za vejico
  n = n.replace(/,.*/, "");
  // 3. Odstranimo oklepaje
  n = n.replace(/\s*\(.*?\)/g, "");
  // 4. Odstranimo predpone mest SAMO, če za njimi obstaja še ime postaje
  n = n.replace(/^(ljubljana|lj\.|mb\.|maribor|koper|kp\.|celje|ce\.)\s+(.+)/, "$2");
  // 5. Odstranimo vse, kar ni črka ali številka
  return n.replace(/[^a-z0-9]/g, "");
}

async function fetchAndProcessStations() {
  const API_URL = "https://api.beta.brezavta.si/stops/";
  const OUT_DIR = "station_lists_merged";
  const LINE_LISTS_DIR = "station_line_lists";

  try {
    const response = await fetch(API_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`HTTP napaka! Status: ${response.status}`);
    const allStops = await response.json();

    const ghUrl = `https://raw.githubusercontent.com/TeamBusylj/LPPDetoursFetch/refs/heads/main/stop_to_routes.json?t=${Date.now()}`;
    let externalStopToRoutes = {};
    try {
      const ghRes = await fetch(ghUrl);
      if (ghRes.ok) externalStopToRoutes = await ghRes.json();
    } catch (e) {
      console.warn("Opozorilo: Ni bilo mogoče prenesti Github stop_to_routes.json");
    }

    // PREDNALAGANJE SZ.JSON IN IJPP.JSON
    let szKnownIds = {};
    let ijppKnownIds = {};
    try {
      const szData = await fs.readFile(path.join(LINE_LISTS_DIR, 'sz.json'), 'utf-8');
      szKnownIds = JSON.parse(szData) || {};
    } catch (e) {
      console.warn("Opozorilo: sz.json še ne obstaja.");
    }
    
    try {
      const ijppData = await fs.readFile(path.join(LINE_LISTS_DIR, 'ijpp.json'), 'utf-8');
      ijppKnownIds = JSON.parse(ijppData) || {};
    } catch (e) {
      console.warn("Opozorilo: ijpp.json še ne obstaja.");
    }

    const agencyGroups = {};
    for (const station of allStops) {
      if (!station.gtfs_id) continue;
      
      let agency = station.gtfs_id.split(':')[0].toLowerCase();
      const stationIdStr = station.gtfs_id.substring(station.gtfs_id.indexOf(':') + 1);
      
      if (szKnownIds[stationIdStr] || station.type === "RAIL" || agency === "sž" || agency === "sz") {
        agency = "sz";
        station.type = "RAIL"; 
        station.background_color = "#00A8EB";
      }

      if (station.type === "BUS" || station.type === "RAIL") {
        if (!agencyGroups[agency]) agencyGroups[agency] = [];
        agencyGroups[agency].push(station);
        
        // DODAJANJE IJPP POSTAJE V LPP SKUPINO (če je ekskluzivno LPP)
        if (agency === "ijpp" && ijppKnownIds[stationIdStr] && ijppKnownIds[stationIdStr].length === 1 && ijppKnownIds[stationIdStr][0] === "1118") {
            if (!agencyGroups["lpp"]) agencyGroups["lpp"] = [];
            agencyGroups["lpp"].push({ ...station });
        }
      }
    }

    await fs.mkdir(OUT_DIR, { recursive: true });

    for (const [agency, stops] of Object.entries(agencyGroups)) {
      
      let localCache = {};
      try {
        const localData = await fs.readFile(path.join(LINE_LISTS_DIR, `${agency}.json`), 'utf-8');
        localCache = JSON.parse(localData) || {};
      } catch (err) {}

      let routesStationsCache = {};
      let stopToAgenciesCache = {};

      if (agency === "sz" || agency === "ijpp") {
        routesStationsCache = externalStopToRoutes;
        stopToAgenciesCache = localCache; 
      } else {
        routesStationsCache = localCache; 
        stopToAgenciesCache = {};
      }

      const stopsByNum = new Map();
      const stopsByNameAndNum = new Map();

      stops.forEach(station => {
        const stationIdStr = station.gtfs_id.slice(station.gtfs_id.lastIndexOf(":") + 1);
        const baseNum = agency === "lpp" ? (Number(station.code) || parseInt(stationIdStr)) : parseInt(stationIdStr);
        
        const enriched = { ...station, _baseNum: baseNum };
        stopsByNum.set(baseNum, enriched);
        
        // Popravek za pametno iskanje nasprotne postaje
        const sName = station.name || station.stop_name || "";
        const normNameForOpposite = normalizeName(sName);
        stopsByNameAndNum.set(`${normNameForOpposite}_${baseNum}`, enriched);
      });

      const processedStops = stops.map(station => {
        const stationIdStr = station.gtfs_id.split(":")[1];
        const parsedIdNum = parseInt(station.gtfs_id.slice(station.gtfs_id.lastIndexOf(":") + 1));
        const sName = station.name || station.stop_name || "";
        const normNameForOpposite = normalizeName(sName);
        
        let exists = null;

        if (agency !== "ijpp" && agency !== "sz") {
          let checkNum = null;
          let stationNum = agency === "lpp" ? (Number(station.code) || parsedIdNum + 1) : parsedIdNum + 1;

          if (agency !== "lpp") {
            const neighborPrev = stopsByNameAndNum.get(`${normNameForOpposite}_${stationNum - 1}`);
            const neighborNext = stopsByNameAndNum.get(`${normNameForOpposite}_${stationNum + 1}`);
            const matchingNeighbor = neighborPrev || neighborNext;

            if (matchingNeighbor) {
              checkNum = matchingNeighbor._baseNum;
            }
          }

          if (checkNum == null) {
            if (agency === "lpp") {
              checkNum = stationNum % 2 === 0 ? stationNum - 1 : stationNum + 1;
            } else {
              checkNum = stationNum % 2 === 0 ? stationNum + 1 : stationNum - 1;
            }
          }

          const foundOpposite = stopsByNum.get(checkNum);
          exists = foundOpposite ? (foundOpposite.code || foundOpposite.gtfs_id) : null;
        }

        const resultStation = {
          ...station,
          opposite: exists
        };

        if (agency === "ijpp" || agency === "sz") {
          resultStation.agencies = stopToAgenciesCache[stationIdStr] || [];
        } else {
          resultStation.routes = routesStationsCache[stationIdStr] || [];
        }

        return resultStation;
      });

      // --- DODAJANJE HUB IDENTIFIKATORJEV (Brez brisanja originalnih postaj) ---
      const hubs = [];
      
      // 1. Zberemo postaje v navidezne hube
      for (const station of processedStops) {
        const stationName = station.name || station.stop_name || "";
        const normName = normalizeName(stationName);
        const sLat = parseFloat(station.lat || station.stop_lat);
        const sLon = parseFloat(station.lon || station.stop_lon);
        
        let foundHub = null;
        for (const hub of hubs) {
          if (hub._normName === normName) {
            const dist = getDistanceFromLatLonInM(hub.lat, hub.lon, sLat, sLon);
            if (dist < 250) {
              foundHub = hub;
              break;
            }
          }
        }
        
        if (foundHub) {
          foundHub.stations.push(station);
        } else {
          hubs.push({
            _normName: normName,
            lat: sLat, // Centriramo na prvo najdeno postajo
            lon: sLon,
            stations: [station]
          });
        }
      }

      // 2. Vsaki postaji pripnemo njene Hub lastnosti
      for (let hIndex = 0; hIndex < hubs.length; hIndex++) {
        const hub = hubs[hIndex];
        const hubId = `hub_${hub._normName}_${hIndex}`; // Unikaten ID za to vozlišče
        
        // Zberemo vse ID-je iz vseh postaj v tem hubu
        const allIds = hub.stations.map(s => s.gtfs_id).filter(Boolean);
        const allCodes = [...new Set(hub.stations.map(s => s.code).filter(Boolean))];

        for (const station of hub.stations) {
          station.hub_id = hubId;
          station.merged_stop_ids = allIds; // Vsebuje ID-je vseh sosednjih postaj v istem hubu
          if (allCodes.length > 0) {
            station.merged_codes = allCodes;
          }
        }
      }

      // processedStops ima zdaj izvirno dolžino, ampak so objekti obogateni s hub_id in merged_stop_ids
      const outPath = path.join(OUT_DIR, `${agency}.json`);
      await fs.writeFile(outPath, JSON.stringify(processedStops, null, 2), "utf-8");
      
      console.log(`✅ Shranjeno: ${agency}.json (${processedStops.length} postaj z dodeljenimi Hub ID-ji).`);
    }

    console.log("Vse agencije so bile uspešno procesirane!");
  } catch (error) {
    console.error("Napaka pri pridobivanju/procesiranju postaj:", error);
    process.exit(1);
  }
}

fetchAndProcessStations();
