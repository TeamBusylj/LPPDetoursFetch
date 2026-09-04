import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OTP_URL = 'https://otp.ojpp-gateway.derp.si/otp/gtfs/v1';
// Posodobljena pot, da se ujema s tvojo GitHub Akcijo!
const OUTPUT_DIR = path.join(__dirname, '../station_line_lists');

// Tvoj slovar barv za LPP medkrajevne linije
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

const query = `
  query {
    stops {
      gtfsId
      vehicleMode
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

async function fetchStops() {
    console.log(`Pridobivam podatke z ${OTP_URL}...`);
    const response = await fetch(OTP_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
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

    return json.data.stops;
}

async function main() {
    try {
        const rawStops = await fetchStops();
        console.log(`Pridobil ${rawStops.length} postaj. Generiram slovarje...`);

        const routesByAgency = {};
        const protectedLppIds = new Set();

       for (const stop of rawStops) {
            if (!stop.gtfsId || !stop.vehicleMode) continue;

            let agency = stop.gtfsId.split(':')[0].toLowerCase();
            const stationIdStr = stop.gtfsId.substring(stop.gtfsId.indexOf(':') + 1).trim();

            const hasSZRoute = (stop.routes || []).some(r => r.agency.gtfsId && r.agency.gtfsId === 'IJPP:1161');

            if (stop.vehicleMode === 'RAIL' || agency === 'sž' || agency === 'sz' || hasSZRoute) {
                agency = 'sz';
                stop.vehicleMode = 'RAIL';
            }

            if (!routesByAgency[agency]) {
                routesByAgency[agency] = {};
            }

            let formattedData = [];
            const routes = stop.routes || [];

            if (agency === 'sz') {
                const trainTypes = routes
                    .map(r => r.shortName)
                    .filter(Boolean)
                    .map(name => name.split(' ')[0])
                    .filter(name => /^[A-Za-z]+$/.test(name));
                
                formattedData = [...new Set(trainTypes)];
                formattedData.sort();
            } 
            else if (agency === 'ijpp') {
                const agencyIds = routes
                    .map(r => r.agency?.gtfsId)
                    .filter(Boolean)
                    .map(id => id.replace(/^IJPP:/i, '').trim())
                    .filter(Boolean);
                
                const uniqueAgencies = [...new Set(agencyIds)];
                uniqueAgencies.sort();
                formattedData = uniqueAgencies;
                
                if (uniqueAgencies.length === 1 && uniqueAgencies[0] === '1118') {
                    console.log(`[DEBUG] Našel IJPP postajo ekskluzivno za LPP: ${stationIdStr}`);
                    
                    if (!routesByAgency['lpp']) {
                        routesByAgency['lpp'] = {};
                    }
                    
                    const uniqueRoutes = new Map();
                    routes.forEach(route => {
                        let name = route.shortName || 'N/A';
                        if (!uniqueRoutes.has(name)) {
                            // Tukaj preverimo tvoj slovar barv
                            let finalColor = route.color ? `#${route.color}` : '#000000';
                            if (lineColorsObj[name]) {
                                finalColor = lineColorsObj[name];
                            }
                            
                            uniqueRoutes.set(name, {
                                name: name,
                                color: finalColor
                            });
                        }
                    });
                    
                    let lppFormattedData = Array.from(uniqueRoutes.values());

                    lppFormattedData.sort((a, b) => {
                        const nameA = a.name;
                        const nameB = b.name;
                        const numA = parseInt(nameA.replace(/\D/g, ''), 10);
                        const numB = parseInt(nameB.replace(/\D/g, ''), 10);
                        const hasNumA = !isNaN(numA);
                        const hasNumB = !isNaN(numB);

                        if (hasNumA && hasNumB) {
                            if (numA === numB) return nameA.localeCompare(nameB);
                            return numA - numB;
                        } 
                        else if (hasNumA) return -1;
                        else if (hasNumB) return 1;
                        else return nameA.localeCompare(nameB);
                    });

                    protectedLppIds.add(stationIdStr);
                    routesByAgency['lpp'][stationIdStr] = lppFormattedData;
                }
            } 
            else {
                const uniqueRoutes = new Map();
                routes.forEach(route => {
                    let name = route.shortName || 'N/A';
                    
                    if (agency === 'movelenje' && name !== 'N/A') {
                        name = name.charAt(0).toUpperCase();
                    }

                    if (!uniqueRoutes.has(name)) {
                        // In preverimo ga za vsak primer še tukaj (za LPP postaje, ki niso del IJPP bloka)
                        let finalColor = route.color ? `#${route.color}` : '#000000';
                        if (agency === 'lpp' && lineColorsObj[name]) {
                            finalColor = lineColorsObj[name];
                        }

                        uniqueRoutes.set(name, {
                            name: name,
                            color: finalColor
                        });
                    }
                });
                
                formattedData = Array.from(uniqueRoutes.values());

                formattedData.sort((a, b) => {
                    const nameA = a.name;
                    const nameB = b.name;
                    const numA = parseInt(nameA.replace(/\D/g, ''), 10);
                    const numB = parseInt(nameB.replace(/\D/g, ''), 10);
                    const hasNumA = !isNaN(numA);
                    const hasNumB = !isNaN(numB);

                    if (hasNumA && hasNumB) {
                        if (numA === numB) return nameA.localeCompare(nameB);
                        return numA - numB;
                    } 
                    else if (hasNumA) return -1;
                    else if (hasNumB) return 1;
                    else return nameA.localeCompare(nameB);
                });
            }

            if (agency === 'lpp' && protectedLppIds.has(stationIdStr)) {
                 // Preskočimo, da ne povozimo tistega, kar smo ustvarili zgoraj
            } else {
                 routesByAgency[agency][stationIdStr] = formattedData;
            }
        }

        await fs.mkdir(OUTPUT_DIR, { recursive: true });

        for (const [agency, dataMap] of Object.entries(routesByAgency)) {
            const filePath = path.join(OUTPUT_DIR, `${agency}.json`);
            const jsonData = JSON.stringify(dataMap, null, 2);
            await fs.writeFile(filePath, jsonData, 'utf-8');
            console.log(`Shranjeno: ${agency}.json (Vsebuje zapise za ${Object.keys(dataMap).length} postaj)`);
        }

        console.log('Postopek uspešno zaključen!');

    } catch (error) {
        console.error('Prišlo je do napake med izvajanjem:', error);
        process.exit(1);
    }
}

main();
