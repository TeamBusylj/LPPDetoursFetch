const fs = require('fs');
const readline = require('readline');

async function processGTFS() {
    const tripToRoute = {};
    const stopToRoutes = {};

    // Pomožna funkcija za asinhrono branje CSV po vrsticah (prepreči Out of Memory)
    const processFile = async (filename, callback) => {
        if (!fs.existsSync(filename)) {
            console.error(`Datoteka ${filename} ne obstaja!`);
            return;
        }
        
        const fileStream = fs.createReadStream(filename);
        const rl = readline.createInterface({ 
            input: fileStream, 
            crlfDelay: Infinity 
        });
        
        let headers = null;

        for await (const line of rl) {
            // Odstranimo morebitne narekovaje za čistejše podatke
            const cleanLine = line.replace(/"/g, ''); 
            
            if (!headers) {
                headers = cleanLine.split(',').map(h => h.trim());
                continue;
            }
            
            const values = cleanLine.split(',');
            const row = {};
            headers.forEach((h, i) => { 
                row[h] = values[i]?.trim(); 
            });
            
            callback(row);
        }
    };

    console.log("Obdelujem trips.txt...");
    await processFile('gtfs/trips.txt', (row) => {
        if (row.trip_id && row.route_id) {
            tripToRoute[row.trip_id] = row.route_id;
        }
    });

    console.log("Obdelujem stop_times.txt...");
    await processFile('gtfs/stop_times.txt', (row) => {
        const routeId = tripToRoute[row.trip_id];
        const stopId = row.stop_id;
        
        if (routeId && stopId) {
            if (!stopToRoutes[stopId]) stopToRoutes[stopId] = new Set();
            stopToRoutes[stopId].add(routeId);
        }
    });

    console.log("Generiram JSON...");
    const output = {};
    for (const stopId in stopToRoutes) {
        output[stopId] = Array.from(stopToRoutes[stopId]);
    }

    fs.writeFileSync('stop_to_routes.json', JSON.stringify(output, null, 2));
    console.log("Končano! Podatki so shranjeni v stop_to_routes.json");
}

processGTFS().catch(console.error);
