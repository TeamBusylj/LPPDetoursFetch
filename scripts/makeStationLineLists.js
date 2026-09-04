import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OTP_URL = 'https://otp.ojpp-gateway.derp.si/otp/gtfs/v1';
const OUTPUT_DIR = path.join(__dirname, 'station_line_lists');

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

       for (const stop of rawStops) {
            if (!stop.gtfsId || !stop.vehicleMode) continue;

            let agency = stop.gtfsId.split(':')[0].toLowerCase();
            const stationIdStr = stop.gtfsId.substring(stop.gtfsId.indexOf(':') + 1);

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
                    .map(id => id.replace(/^IJPP:/i, ''))
                    .filter(Boolean);
                
                const uniqueAgencies = [...new Set(agencyIds)];
                uniqueAgencies.sort();
                formattedData = uniqueAgencies;
                
                // ČE JE EKSKLUZIVNO LPP (1118), LINIJE DODAMO ŠE V LPP DATOTEKO
                if (uniqueAgencies.length === 1 && uniqueAgencies[0] === '1118') {
                    if (!routesByAgency['lpp']) {
                        routesByAgency['lpp'] = {};
                    }
                    
                    const uniqueRoutes = new Map();
                    routes.forEach(route => {
                        let name = route.shortName || 'N/A';
                        if (!uniqueRoutes.has(name)) {
                            uniqueRoutes.set(name, {
                                name: name,
                                color: route.color ? `#${route.color}` : '#000000'
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
                        uniqueRoutes.set(name, {
                            name: name,
                            color: route.color ? `#${route.color}` : '#000000'
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

            routesByAgency[agency][stationIdStr] = formattedData;
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
