const cloudinary = require('cloudinary').v2;

const clean = v => v ? String(v).trim().replace(/^=+/, '') : '';

// Soporte para CLOUDINARY_URL o variables individuales
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ cloudinary_url: clean(process.env.CLOUDINARY_URL) });
} else {
  cloudinary.config({
    cloud_name: clean(process.env.CLOUDINARY_CLOUD_NAME),
    api_key:    clean(process.env.CLOUDINARY_API_KEY),
    api_secret: clean(process.env.CLOUDINARY_API_SECRET),
  });
}

/**
 * Sube un archivo a Cloudinary y devuelve su URL pública.
 */
async function uploadToStorage(fileBuffer, originalname, folder = 'uploads') {
  const buffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(String(fileBuffer), 'utf8');

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: `macstore/${folder}`, resource_type: 'auto', unique_filename: true },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    uploadStream.end(buffer);
  });
}

module.exports = { uploadToStorage };
