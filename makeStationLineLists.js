const fs = require('fs/promises');
const path = require('path');

// URL naslov OTP strežnika
const OTP_URL = 'https://otp.ojpp-gateway.derp.si/otp/gtfs/v1';

// Mape, kjer bodo shranjeni rezultati
const OUTPUT_DIR = path.join(__dirname, 'station_line_lists');

// Konfiguracija barv (lahko dopolniš s preostalimi agencijami)
const stop_background_colors = {
    'MARPROM': '#800000',
    'LPP': '#00A859',
    'SŽ': '#005AAA',
    'DEFAULT': '#000000'
};

const stop_icon_colors = {
    'DEFAULT': '#FFFFFF'
};

// GraphQL poizvedba
const query = `
  query {
    stops {
      id
      gtfsId
      code
      vehicleMode
      name
      lat
      lon
      routes {
        shortName
        color
      }
    }
  }
`;

/**
 * Funkcija za pridobivanje podatkov iz strežnika
 */
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

/**
 * Pomožna funkcija za izračun prevoznika/agencije iz gtfsId
 */
function getAgencyFromGtfsId(gtfsId, vehicleMode) {
    if (vehicleMode === 'RAIL') return 'SŽ';
    if (!gtfsId) return 'UNKNOWN';
    return gtfsId.split(':')[0]; // Npr. "MARPROM:10" -> "MARPROM"
}

/**
 * Pomožna funkcija za nasprotno postajo (opposite)
 * Zaenkrat vrne kar isto kodo - tukaj lahko dodaš svojo logiko
 */
function calculateOpposite(code) {
    return code || null;
}

/**
 * Glavna funkcija za obdelavo
 */
async function main() {
    try {
        const rawStops = await fetchStops();
        console.log(`Pridobil ${rawStops.length} postaj. Obdelujem...`);

        // Objekt, kamor bomo razvrstili postaje po ponudnikih
        const stationsByAgency = {};

        for (const stop of rawStops) {
            // Izpustimo postaje brez tipa vozila
            if (!stop.vehicleMode) continue;

            const agency = getAgencyFromGtfsId(stop.gtfsId, stop.vehicleMode);
            
            // Pripravimo barve
            const bgColor = stop_background_colors[agency] || stop_background_colors['DEFAULT'];
            const iconColor = stop_icon_colors[agency] || stop_icon_colors['DEFAULT'];

            // Pripravimo seznam linij
            const formattedRoutes = (stop.routes || []).map(route => ({
                name: route.shortName || 'N/A',
                color: route.color ? `#${route.color}` : '#000000'
            }));

            // Ustvarimo objekt po tvojem formatu
            const formattedStop = {
                id: stop.id,
                gtfs_id: stop.gtfsId,
                code: stop.code,
                type: stop.vehicleMode,
                background_color: bgColor,
                icon_color: iconColor,
                name: stop.name,
                lat: stop.lat,
                lon: stop.lon,
                opposite: calculateOpposite(stop.code),
                routes: formattedRoutes
            };

            // Dodamo v ustrezno skupino ponudnika
            if (!stationsByAgency[agency]) {
                stationsByAgency[agency] = [];
            }
            stationsByAgency[agency].push(formattedStop);
        }

        // Ustvari mapo, če še ne obstaja
        await fs.mkdir(OUTPUT_DIR, { recursive: true });

        // Shrani vsakega ponudnika v svojo datoteko
        const agencies = Object.keys(stationsByAgency);
        for (const agency of agencies) {
            const filePath = path.join(OUTPUT_DIR, `${agency.toLowerCase()}.json`);
            
            // Formatiramo v lep JSON (z zamikom 2 presledkov)
            const jsonData = JSON.stringify(stationsByAgency[agency], null, 2);
            
            await fs.writeFile(filePath, jsonData, 'utf-8');
            console.log(`Shranjeno: ${filePath} (${stationsByAgency[agency].length} postaj)`);
        }

        console.log('Postopek uspešno zaključen!');

    } catch (error) {
        console.error('Prišlo je do napake med izvajanjem:', error);
        process.exit(1);
    }
}

// Zagon skripte
main();
