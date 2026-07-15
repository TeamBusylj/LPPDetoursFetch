import fs from 'fs/promises';
import path from 'path';

async function fetchAndProcessStations() {
  const API_URL = "https://api.beta.brezavta.si/stops/";
  const OUT_DIR = "station_lists";
  const LINE_LISTS_DIR = "station_line_lists"; // Tvoja mapa z lop.json, ijpp.json, sz.json, itd.

  try {
    // 1. Prenos vseh postaj iz API-ja
    const response = await fetch(API_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`HTTP napaka! Status: ${response.status}`);
    const allStops = await response.json();

    // 2. Prenos Github datoteke za sž (preprečitev cacha ni nujna na serverju, ampak dodamo timestamp)
    const ghUrl = `https://raw.githubusercontent.com/TeamBusylj/LPPDetoursFetch/refs/heads/main/stop_to_routes.json?t=${Date.now()}`;
    let externalStopToRoutes = {};
    try {
      const ghRes = await fetch(ghUrl);
      if (ghRes.ok) externalStopToRoutes = await ghRes.json();
    } catch (e) {
      console.warn("Opozorilo: Ni bilo mogoče prenesti Github stop_to_routes.json");
    }

    // 3. Grupiranje postaj po agenciji & filtriranje glede na tip (BUS / RAIL)
    const agencyGroups = {};
    for (const station of allStops) {
      if (!station.gtfs_id) continue;
      
      let agency = station.gtfs_id.split(':')[0].toLowerCase();
      
      // LOGIKA ZA LOČEVANJE VLAKOV IN AVTOBUSOV:
      // Vse RAIL postaje gredo v datoteko sz.json
      if (station.type === "RAIL") {
        agency = "sz";
      } else if (agency === "sž") {
        // Normalizacija imena, da se ujema z datoteko sz.json
        agency = "sz"; 
      }

      // Shranimo samo BUS in RAIL
      if (station.type === "BUS" || station.type === "RAIL") {
        if (!agencyGroups[agency]) agencyGroups[agency] = [];
        agencyGroups[agency].push(station);
      }
    }

    // Ustvari izvozno mapo, če ne obstaja
    await fs.mkdir(OUT_DIR, { recursive: true });

    // 4. Obdelava vsake agencije posebej
    for (const [agency, stops] of Object.entries(agencyGroups)) {
      
      // Branje lokalnega JSON-a iz repozitorija (npr. sz.json, ijpp.json, lop.json...)
      let localCache = {};
      try {
        const localData = await fs.readFile(path.join(LINE_LISTS_DIR, `${agency}.json`), 'utf-8');
        localCache = JSON.parse(localData) || {};
      } catch (err) {
        // Datoteka ne obstaja za to agencijo, kar je v redu
      }

      // Nastavitev cache logike
      let routesStationsCache = {};
      let stopToAgenciesCache = {};

      if (agency === "sz" || agency === "ijpp") {
        routesStationsCache = externalStopToRoutes;
        stopToAgenciesCache = localCache; // Bere iz sz.json ali ijpp.json
      } else {
        routesStationsCache = localCache; // Bere iz npr. marprom.json, lop.json
        stopToAgenciesCache = {};
      }

      // --- OPTIMIZACIJA: Priprava slovarjev za 'opposite' logiko ---
      const stopsByNum = new Map();
      const stopsByNameAndNum = new Map();

      stops.forEach(station => {
        const stationIdStr = station.gtfs_id.slice(station.gtfs_id.lastIndexOf(":") + 1);
        const baseNum = agency === "lop" ? Number(station.code) : parseInt(stationIdStr);
        
        const enriched = { ...station, _baseNum: baseNum };
        stopsByNum.set(baseNum, enriched);
        stopsByNameAndNum.set(`${station.stop_name}_${baseNum}`, enriched);
      });

      // --- Preslikava (Mapping) podatkov ---
      const processedStops = stops.map(station => {
        const stationIdStr = station.gtfs_id.split(":")[1];
        const parsedIdNum = parseInt(station.gtfs_id.slice(station.gtfs_id.lastIndexOf(":") + 1));
        
        let exists = null;

        // Opposite logika (ne velja za ijpp in sž/sz)
        if (agency !== "ijpp" && agency !== "sz") {
          let checkNum = null;
          let stationNum = agency === "lop" ? Number(station.code) : parsedIdNum + 1;

          if (agency !== "lpp") {
            const neighborPrev = stopsByNameAndNum.get(`${station.stop_name}_${stationNum - 1}`);
            const neighborNext = stopsByNameAndNum.get(`${station.stop_name}_${stationNum + 1}`);
            const matchingNeighbor = neighborPrev || neighborNext;

            if (matchingNeighbor) {
              checkNum = matchingNeighbor._baseNum;
            }
          }

          if (checkNum == null) {
            if (agency === "lpp" || agency === "lop") {
              checkNum = stationNum % 2 === 0 ? stationNum - 1 : stationNum + 1;
            } else {
              checkNum = stationNum % 2 === 0 ? stationNum + 1 : stationNum - 1;
            }
          }

          const foundOpposite = stopsByNum.get(checkNum);
          exists = foundOpposite ? (foundOpposite.code || foundOpposite.gtfs_id) : null;
        }

        // Priprava končnega objekta za postajo
        const resultStation = {
          ...station,
          opposite: exists
        };

        // Specifična pravila za polja agencij in linij
        if (agency === "ijpp" || agency === "sz") {
          // Za IJPP in SŽ samo agencies (iz ijpp.json), BREZ routes
          resultStation.agencies = stopToAgenciesCache[stationIdStr] || [];
        } else {
          // Za vse ostale (LPP, Marprom, ...) samo routes
          resultStation.routes = routesStationsCache[stationIdStr] || [];
        }

        return resultStation;
      });

      // 5. Zapis končne datoteke v station_lists
      const outPath = path.join(OUT_DIR, `${agency}.json`);
      await fs.writeFile(outPath, JSON.stringify(processedStops, null, 2), "utf-8");
      console.log(`✅ Shranjeno: ${agency}.json (${processedStops.length} postaj) z vsemi relacijami.`);
    }

    console.log("Vse agencije so bile uspešno procesirane!");
  } catch (error) {
    console.error("Napaka pri pridobivanju/procesiranju postaj:", error);
    process.exit(1);
  }
}

fetchAndProcessStations();
