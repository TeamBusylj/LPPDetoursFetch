import fs from 'fs/promises';
import path from 'path';

const OTP_URL = 'https://otp.ojpp-gateway.derp.si/otp/gtfs/v1';

const lineColorsObj = {
  "3B": "#5BAF20",
  "3G": "#5BAF20",
  "6B": "#6E7073",
  "12D": "#183875",
  "15": "#8A1D79",
  "19I": "#B96F89",
  "21D": "#3C8C3C",
  "25": "#2387bc",
  "30": "#8AC09D",
  "40": "#41615F",
  "42": "#967C60",
  "43": "#464269",
  "44": "#736F93",
  "51": "#5D77A9",
  "52": "#00545B",
  "53": "#B3A1B5",
  "56": "#6F280D",
  "60": "#9AA769",
  "61": "#D8913F",
  "71": "#5D77A9",
  "72": "#41917F",
  "73": "#D9AC08",
  "78": "#B06A67",
};

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

// Pametni normalizator imen
function normalizeName(name) {
  if (!name) return "";
  let n = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); 
  
  n = n.replace(/\/.*/, "");
  n = n.replace(/,.*/, "");
  n = n.replace(/\s*\(.*?\)/g, "");
  n = n.replace(/^(ljubljana|lj\.|mb\.|maribor|koper|kp\.|celje|ce\.)\s+(.+)/, "$2");
  return n.replace(/[^a-z0-9]/g, "");
}

const query = `
  query {
    stops {
      id
      gtfsId
      vehicleMode
      code
      name
      lat
      lon
      routes {
        shortName
        color
        agency {
          gtfsId
        }
      }
    }
  }
`;

async function fetchAndProcessStations() {
  const OUT_DIR = "station_lists_merged";

  try {
    console.log(`Pridobivam podatke iz: ${OTP_URL}...`);
    const response = await fetch(OTP_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (GitHub Actions)'
        },
        body: JSON.stringify({ query })
    });

    if (!response.ok) {
        throw new Error(`Napaka pri HTTP zahtevku: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    if (json.errors) {
        throw new Error(`GraphQL napaka: ${JSON.stringify(json.errors)}`);
    }

    const allStops = json.data.stops;
    console.log(`Pridobljenih postaj: ${allStops.length}. Začenjam obdelavo...`);

    const agencyGroups = {};
    for (const rawStation of allStops) {
      if (!rawStation.gtfsId) continue;
      
      let agency = rawStation.gtfsId.split(':')[0].toLowerCase();
      
      const station = {
        ...rawStation,
        gtfs_id: rawStation.gtfsId,
        type: rawStation.vehicleMode
      };
      
      if (station.type === "RAIL" || agency === "sž" || agency === "sz") {
        agency = "sz";
        station.type = "RAIL"; 
        station.background_color = "#00A8EB";
      }

      // PREVERJANJE: Ali ima IJPP postaja IZKLJUČNO agencijo 1118 (LPP)?
      let isExclusiveLpp = false;
      if (agency === "ijpp" && station.routes && Array.isArray(station.routes) && station.routes.length > 0) {
          const uniqueAgencies = [...new Set(station.routes.map(r => r.agency?.gtfsId).filter(Boolean))];
          if (uniqueAgencies.length === 1 && (uniqueAgencies[0] === "1118" || uniqueAgencies[0].endsWith(":1118"))) {
              isExclusiveLpp = true;
          }
      }

      if (station.type === "BUS" || station.type === "RAIL") {
        if (!agencyGroups[agency]) agencyGroups[agency] = [];
        agencyGroups[agency].push(station);

        // Če je postaja ekskluzivno LPP (1118), jo dodamo še v lpp.json, da jo ujame Hub logika
        if (isExclusiveLpp) {
            if (!agencyGroups["lpp"]) agencyGroups["lpp"] = [];
            agencyGroups["lpp"].push({ ...station });
        }
      }
    }

    await fs.mkdir(OUT_DIR, { recursive: true });

    for (const [agency, stops] of Object.entries(agencyGroups)) {
      
      const stopsByNum = new Map();
      const stopsByNameAndNum = new Map();

      stops.forEach(station => {
        const stationIdStr = station.gtfs_id.slice(station.gtfs_id.lastIndexOf(":") + 1);
        const baseNum = agency === "lpp" ? (Number(station.code) || parseInt(stationIdStr)) : parseInt(stationIdStr);
        
        const enriched = { ...station, _baseNum: baseNum };
        stopsByNum.set(baseNum, enriched);
        
        const sName = station.name || station.stop_name || "";
        const normNameForOpposite = normalizeName(sName);
        stopsByNameAndNum.set(`${normNameForOpposite}_${baseNum}`, enriched);
      });

      const processedStops = stops.map(station => {
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

        if (station.routes && Array.isArray(station.routes)) {
            resultStation.routes = station.routes.map(r => {
                let finalColor = null;
                // Če imamo custom barvo za to linijo, jo uporabimo
                if (lineColorsObj[r.shortName]) {
                    finalColor = lineColorsObj[r.shortName];
                } 
                // Sicer vzamemo barvo iz GTFS in ji dodamo '#'
                else if (r.color) {
                    finalColor = r.color.startsWith('#') ? r.color : `#${r.color}`;
                }
                
                return {
                    name: r.shortName,
                    color: finalColor
                };
            });
            
            const uniqueAgencies = [...new Set(station.routes.map(r => r.agency?.gtfsId).filter(Boolean))];
            if (uniqueAgencies.length > 0) {
                resultStation.agencies = uniqueAgencies;
            }
        } else {
            resultStation.routes = [];
            resultStation.agencies = [];
        }

        return resultStation;
      });

      const hubs = [];
      
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
            lat: sLat,
            lon: sLon,
            stations: [station]
          });
        }
      }

      for (let hIndex = 0; hIndex < hubs.length; hIndex++) {
        const hub = hubs[hIndex];
        const hubId = `hub_${hub._normName}_${hIndex}`; 
        
        const allIds = hub.stations.map(s => s.gtfs_id).filter(Boolean);
        const allCodes = [...new Set(hub.stations.map(s => s.code).filter(Boolean))];
        
        const routeMap = new Map();
        for (const station of hub.stations) {
          if (station.routes) {
            station.routes.forEach(r => routeMap.set(typeof r === 'object' ? r.name : r, r));
          }
        }
        let allRoutes = Array.from(routeMap.values());
        
        allRoutes.sort((a, b) => {
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

        let allAgencies = [];
        for (const station of hub.stations) {
           if (station.agencies) {
              allAgencies = [...allAgencies, ...station.agencies];
           }
        }
        allAgencies = [...new Set(allAgencies)].sort();

        for (const station of hub.stations) {
          station.hub_id = hubId;
          station.merged_stop_ids = allIds;
          
          if (allCodes.length > 0) {
            station.merged_codes = allCodes;
          }
          if (allRoutes.length > 0) {
             station.routes = allRoutes;
          }
          if (allAgencies.length > 0) {
             station.agencies = allAgencies;
          }
          
          for (const s of hub.stations) {
             const sName = s.name || s.stop_name || "";
             const currName = station.name || station.stop_name || "";
             if (sName.length < currName.length && !sName.includes("/")) {
                station.name = sName.trim();
             }
          }
        }
      }

      const outPath = path.join(OUT_DIR, `${agency}.json`);
      await fs.writeFile(outPath, JSON.stringify(processedStops, null, 2), "utf-8");
      
      console.log(`✅ Shranjeno: ${agency}.json (${processedStops.length} postaj z dodeljenimi Hub ID-ji).`);
    }

    console.log("Vse agencije so bile uspešno procesirane in shranjene v mapo 'station_lists_merged'!");

  } catch (error) {
    console.error("Napaka pri pridobivanju/procesiranju postaj:", error);
    process.exit(1);
  }
}

fetchAndProcessStations();
