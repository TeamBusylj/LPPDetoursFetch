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

async function fetchAndProcessStations() {
  const API_URL = "https://api.beta.brezavta.si/stops/";
  const OUT_DIR = "station_lists";
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
        
        // POPRAVEK: Branje polja 'name' namesto 'stop_name'
        const sName = station.name || station.stop_name || "";
        stopsByNameAndNum.set(`${sName}_${baseNum}`, enriched);
      });

      const processedStops = stops.map(station => {
        const stationIdStr = station.gtfs_id.split(":")[1];
        const parsedIdNum = parseInt(station.gtfs_id.slice(station.gtfs_id.lastIndexOf(":") + 1));
        const sName = station.name || station.stop_name || "";
        
        let exists = null;

        if (agency !== "ijpp" && agency !== "sz") {
          let checkNum = null;
          let stationNum = agency === "lpp" ? (Number(station.code) || parsedIdNum + 1) : parsedIdNum + 1;

          if (agency !== "lpp") {
            const neighborPrev = stopsByNameAndNum.get(`${sName}_${stationNum - 1}`);
            const neighborNext = stopsByNameAndNum.get(`${sName}_${stationNum + 1}`);
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

      // --- ZDRUŽEVANJE POSTAJ V VOZLIŠČA (HUBS) ---
      const hubs = [];
      
      for (const station of processedStops) {
        // POPRAVEK: Varnostno branje polja 'name' 
        const stationName = station.name || station.stop_name || "";
        const normName = stationName.trim().toLowerCase();
        
        // POPRAVEK: Varnostno branje lat in lon
        const sLat = station.lat || station.stop_lat;
        const sLon = station.lon || station.stop_lon;
        
        let foundHub = null;
        for (const hub of hubs) {
          if (hub._normName === normName) {
            const hLat = hub.lat || hub.stop_lat;
            const hLon = hub.lon || hub.stop_lon;
            
            const dist = getDistanceFromLatLonInM(hLat, hLon, sLat, sLon);
            // Povečano na 250m!
            if (dist < 250) {
              foundHub = hub;
              break;
            }
          }
        }
        
        if (foundHub) {
          // Združimo postajo v obstoječi hub
          foundHub.merged_stop_ids.push(station.gtfs_id);
          
          if (station.code) {
             if (!foundHub.merged_codes) foundHub.merged_codes = foundHub.code ? [foundHub.code] : [];
             if (!foundHub.merged_codes.includes(station.code)) {
                 foundHub.merged_codes.push(station.code);
             }
          }
          
          // Združimo in unikatno filtriramo linije (routes)
          if (station.routes) {
            const routeMap = new Map();
            (foundHub.routes || []).forEach(r => routeMap.set(typeof r === 'object' ? r.name : r, r));
            station.routes.forEach(r => routeMap.set(typeof r === 'object' ? r.name : r, r));
            foundHub.routes = Array.from(routeMap.values());
            
            foundHub.routes.sort((a, b) => {
                const nameA = typeof a === 'object' ? a.name : a;
                const nameB = typeof b === 'object' ? b.name : b;
                const numA = parseInt(nameA.replace(/\D/g, ''), 10);
                const numB = parseInt(nameB.replace(/\D/g, ''), 10);
                if (!isNaN(numA) && !isNaN(numB)) {
                    if (numA === numB) return nameA.localeCompare(nameB);
                    return numA - numB;
                }
                if (!isNaN(numA)) return -1;
                if (!isNaN(numB)) return 1;
                return nameA.localeCompare(nameB);
            });
          }
          
          // Združimo in unikatno filtriramo agencije (agencies)
          if (station.agencies) {
            foundHub.agencies = [...new Set([...(foundHub.agencies || []), ...station.agencies])].sort();
          }
          
        } else {
          // Ustvarimo nov hub iz trenutne postaje
          const newHub = { 
            ...station, 
            merged_stop_ids: [station.gtfs_id], 
            _normName: normName 
          };
          if (station.code) {
             newHub.merged_codes = [station.code];
          }
          hubs.push(newHub);
        }
      }

      hubs.forEach(hub => delete hub._normName);

      const outPath = path.join(OUT_DIR, `${agency}.json`);
      await fs.writeFile(outPath, JSON.stringify(hubs, null, 2), "utf-8");
      console.log(`✅ Shranjeno: ${agency}.json (Združeno v ${hubs.length} vozlišč iz originalnih ${processedStops.length} postaj).`);
    }

    console.log("Vse agencije so bile uspešno procesirane!");
  } catch (error) {
    console.error("Napaka pri pridobivanju/procesiranju postaj:", error);
    process.exit(1);
  }
}

fetchAndProcessStations();
