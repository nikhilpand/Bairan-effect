const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const heicConvert = require('heic-convert');
const sharp = require('sharp');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const IMAGES_DIR = process.argv[2] || 'middle-images';
const OUTPUT = process.argv[3] || path.join(__dirname, 'output/middle-slideshow.mp4');
const DURATION = 9;
const IMAGE_DURATION = 0.20;

const OUTPUT_DIR = path.dirname(OUTPUT);
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function createSlideshow() {
  console.log(`🎬 Creating looping slideshow from ${IMAGES_DIR}\n`);
  console.log(`Output: ${OUTPUT}\n`);

  const files = fs.readdirSync(IMAGES_DIR)
    .filter(f => /\.(jpg|jpeg|png|heic|HEIC|JPG|JPEG|webp|WEBP|jfif|JFIF)$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`No images found in ${IMAGES_DIR}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} images`);
  console.log(`Each image displays for ${IMAGE_DURATION}s`);

  let totalFrames = Math.ceil(DURATION / IMAGE_DURATION);
  console.log(`Total frames: ${totalFrames}\n`);

  const tempDir = path.join(OUTPUT_DIR, 'temp-images');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  console.log('Converting to JPG (parallel)...');
  
  const convertImage = async (file, idx) => {
    const ext = path.extname(file).toLowerCase();
    const jpgPath = path.join(tempDir, `img_${String(idx).padStart(2, '0')}.jpg`);
    const inputPath = path.join(IMAGES_DIR, file);
    
    try {
      if (ext === '.heic') {
        const inputBuffer = fs.readFileSync(inputPath);
        const outputBuffer = await heicConvert({
          buffer: inputBuffer,
          format: 'JPEG',
          quality: 0.95
        });
        fs.writeFileSync(jpgPath, outputBuffer);
      } else {
        // Use Sharp instead of ImageMagick
        await sharp(inputPath)
          .jpeg({ quality: 90 })
          .toFile(jpgPath);
      }
      return { file, success: true };
    } catch (e) {
      return { file, success: false, error: e.message };
    }
  };
  
  const convertPromises = files.map((file, idx) => convertImage(file, idx + 1));
  const results = await Promise.all(convertPromises);
  
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success);
  
  console.log(`✓ Converted ${succeeded}/${files.length} images`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(`✗ Failed: ${f.file} - ${f.error}`));
  }
  console.log('');

  const listFile = path.join(tempDir, 'list.txt');
  let listContent = '';
  
  // We need to use img_XX where XX starts from 01 (matching idx+1 in convertImage)
  for (let i = 0; i < totalFrames; i++) {
    const imgIndex = (i % files.length) + 1;
    const imgPath = path.resolve(tempDir, `img_${String(imgIndex).padStart(2, '0')}.jpg`).replace(/\\/g, '/');
    if (fs.existsSync(imgPath)) {
      listContent += `file '${imgPath.replace(/'/g, "'\\''")}'\n`;
      listContent += `duration ${IMAGE_DURATION}\n`;
    }
  }
  // FFmpeg concat demuxer requirement: repeat the last file entry without duration
  const lastImgIndex = (totalFrames % files.length) + 1;
  const lastImg = path.resolve(tempDir, `img_${String(lastImgIndex).padStart(2, '0')}.jpg`).replace(/\\/g, '/');
  if (fs.existsSync(lastImg)) {
    listContent += `file '${lastImg.replace(/'/g, "'\\''")}'\n`;
  }

  fs.writeFileSync(listFile, listContent);
  console.log('Created image list file');

  console.log('Generating slideshow video...');
  const absoluteOutput = path.resolve(OUTPUT);
  try {
    execSync(
        `${FFMPEG} -y -f concat -safe 0 -i "${listFile}" -r 30 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -t ${DURATION} "${absoluteOutput}"`,
        { stdio: 'inherit' }
    );

    fs.unlinkSync(listFile);
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`✅ Saved: ${OUTPUT}`);
  } catch (err) {
    console.error('FFMPEG failed:', err.message);
    throw err;
  }
}

createSlideshow().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
