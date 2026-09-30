import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Poustvarimo __dirname za ES Module (ker uporabljamo 'import')
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OTP_URL = 'https://otp.ojpp-gateway.derp.si/otp/gtfs/v1';

const lineColorsObj = {
  "3B": "#5BAF20",
  "3G": "#5BAF20",
  "6B": "#6E7073",
  "12D": "#183875",
  15: "#8A1D79",
  "19I": "#B96F89",
  "21D": "#3C8C3C",
  25: "#2387BC",
  30: "#8AC09D",
  31: "#7A56A1",
  32: "#DA9D56",
  33: "#77A8B3",
  34: "#E35692",
  35: "#514D6E",
  36: "#D4A747",
  37: "#3A7C7E",
  38: "#E67527",
  39: "#9C6E58",
  40: "#496E6D",
  41: "#D6E7A3",
  42: "#A78B6B",
  43: "#4E497A",
  44: "#817EA8",
  45: "#A74243",
  46: "#8F6B8E",
  47: "#D3954A",
  48: "#72C9B6",
  49: "#CB4577",
  50: "#6A789A",
  51: "#6C8BC6",
  52: "#00565D",
  53: "#C7B3CA",
  54: "#D8AF56",
  55: "#43577B",
  56: "#953312",
  57: "#E58E50",
  58: "#908B9E",
  59: "#BFD264",
  60: "#ACBB71",
  61: "#F9A64A",
  62: "#9E7352",
  63: "#3F9D9E",
  64: "#EF7D50",
  65: "#5D5C6B",
  66: "#D3B257",
  67: "#4D917F",
  68: "#E27851",
  69: "#A2755B",
  70: "#A8CDB5",
  71: "#6C8BC6",
  72: "#4CA391",
  73: "#FECA0A",
  74: "#D65274",
  75: "#B8B3D5",
  76: "#D4B158",
  77: "#61937F",
  78: "#C96D6A",
  79: "#EF8251",
  80: "#75685C",
  81: "#75685C",
  82: "#75685C",
  83: "#75685C",
  85: "#75685C",
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

      // Odstranimo podvojena polja, ker uporabljamo gtfs_id in type
      delete station.gtfsId;
      delete station.vehicleMode;
      
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
      
      const processedStops = stops.map(station => {
        const resultStation = {
          ...station
        };

        if (station.routes && Array.isArray(station.routes)) {
            resultStation.routes = station.routes.map(r => {
                let originalRouteName = (r.shortName !== null && r.shortName !== undefined) ? String(r.shortName) : "";
                
                // TUKAJ JE SPREMEMBA: Preveri, če je ime "N/A" (ne glede na velike/male črke) in ga spremeni v ""
                if (originalRouteName.toUpperCase() === "N/A") {
                    originalRouteName = "";
                }
                
                let finalColor = null;
                if (lineColorsObj[originalRouteName]) {
                    finalColor = lineColorsObj[originalRouteName];
                } 
                else if (r.color) {
                    finalColor = r.color.startsWith('#') ? r.color : `#${r.color}`;
                }
                
                let processedRouteName = originalRouteName;
                if (agency === "movelenje" && processedRouteName.length > 0) {
                    processedRouteName = processedRouteName.charAt(0);
                }

                return {
                    name: processedRouteName,
                    color: finalColor
                };
            });
            
            if (agency === "sz") {
                const trainTypes = station.routes
                    .map(r => {
                        let name = (r.shortName !== null && r.shortName !== undefined) ? String(r.shortName) : "";
                        return name.toUpperCase() === "N/A" ? "" : name;
                    })
                    .map(name => name.split(" ")[0].trim())
                    .filter(type => type && !/^\d+$/.test(type)); 
                
                const uniqueTrainTypes = [...new Set(trainTypes)];
                if (uniqueTrainTypes.length > 0) {
                    resultStation.agencies = uniqueTrainTypes;
                } else {
                    resultStation.agencies = [];
                }
            } else {
                let uniqueAgencies = [...new Set(station.routes.map(r => r.agency?.gtfsId).filter(Boolean))];
                
                // Odstranimo predpono IJPP:, če obstaja
                if (agency === "ijpp") {
                    uniqueAgencies = uniqueAgencies.map(a => a.replace(/^IJPP:/i, ''));
                }

                if (uniqueAgencies.length > 0) {
                    // Ponovno prečistimo duplikate (če sta bila "1118" in "IJPP:1118" prisotna)
                    resultStation.agencies = [...new Set(uniqueAgencies)];
                } else {
                    resultStation.agencies = [];
                }
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
      await fs.writeFile(outPath, JSON.stringify(processedStops), "utf-8");
      
      console.log(`✅ Shranjeno: ${agency}.json (${processedStops.length} postaj v '${OUT_DIR}').`);
    }

    console.log(`Vse agencije so bile uspešno procesirane in shranjene v ${OUT_DIR}!`);

  } catch (error) {
    console.error("Napaka pri pridobivanju/procesiranju postaj:", error);
    process.exit(1);
  }
}

fetchAndProcessStations();
