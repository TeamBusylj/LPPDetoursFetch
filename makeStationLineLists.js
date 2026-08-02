import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Priprava poti v ES modulu
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OTP_URL = 'https://otp.ojpp-gateway.derp.si/otp/gtfs/v1';
const OUTPUT_DIR = path.join(__dirname, 'station_line_lists');

// Poenostavljena poizvedba - potrebujemo samo ID in linije
const query = `
  query {
    stops {
      gtfsId
      vehicleMode
      routes {
        shortName
        color
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

        // Glavni objekt za ločevanje po agencijah
        const routesByAgency = {};

        for (const stop of rawStops) {
            if (!stop.gtfsId || !stop.vehicleMode) continue;

            // 1. Določimo agencijo in jo normaliziramo
            let agency = stop.gtfsId.split(':')[0].toLowerCase();
            if(agency=="ijpp")continue;
            if (stop.vehicleMode === 'RAIL') {
                agency = 'sz';
            } else if (agency === 'sž') {
                agency = 'sz';
            }
          

            // 2. Izluščimo ID postaje (vse za prvim dvopičjem)
            // Npr. "MARPROM:10" -> "10"
            const stationIdStr = stop.gtfsId.substring(stop.gtfsId.indexOf(':') + 1);

            // 3. Pripravimo formatiran seznam linij
            const formattedRoutes = (stop.routes || []).map(route => ({
                name: route.shortName || 'N/A',
                color: route.color ? `#${route.color}` : '#000000'
            }));

            // 4. Inicializiramo agencijo, če še ne obstaja
            if (!routesByAgency[agency]) {
                routesByAgency[agency] = {};
            }

            // 5. Zapišemo pod ustrezen ključ
            routesByAgency[agency][stationIdStr] = formattedRoutes;
        }

        // Ustvari mapo, če še ne obstaja
        await fs.mkdir(OUTPUT_DIR, { recursive: true });

        // Shrani vsako agencijo v svojo datoteko
        for (const [agency, dataMap] of Object.entries(routesByAgency)) {
            const filePath = path.join(OUTPUT_DIR, `${agency}.json`);
            
            // Formatiramo v JSON slovar
            const jsonData = JSON.stringify(dataMap, null, 2);
            
            await fs.writeFile(filePath, jsonData, 'utf-8');
            console.log(`Shranjeno: ${agency}.json (Vsebuje linije za ${Object.keys(dataMap).length} postaj)`);
        }

        console.log('Postopek uspešno zaključen!');

    } catch (error) {
        console.error('Prišlo je do napake med izvajanjem:', error);
        process.exit(1);
    }
}

// Zagon skripte
main();
