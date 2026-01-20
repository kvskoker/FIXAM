const fs = require('fs');
const path = require('path');
const https = require('https');

const assetsDir = path.join(__dirname, '../test_assets');

if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
}

// 1. Download sample audio (short speech)
const audioPath = path.join(assetsDir, 'test_audio.ogg');
const audioUrl = "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg"; 

// 2. Download sample image
const imagePath = path.join(assetsDir, 'test_image.jpg');
const imageUrl = "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png"; // Using PNG as placeholder, will save as jpg extension for test simplicity or just download a valid jpg.
// Actually let's use a real small JPG.
const imageUrl2 = "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b6/Image_created_with_a_mobile_phone.png/640px-Image_created_with_a_mobile_phone.png";

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => resolve(dest));
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {}); // Delete the file async. (But we don't check result)
            reject(err.message);
        });
    });
}

console.log("Downloading test assets...");
Promise.all([
    downloadFile(audioUrl, audioPath),
    downloadFile(imageUrl2, imagePath)
]).then(() => {
    console.log("Test assets downloaded to:", assetsDir);
}).catch(console.error);
