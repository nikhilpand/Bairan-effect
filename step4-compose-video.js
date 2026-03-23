const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const workDir = process.argv[2] || '.';
const OUTPUT_DIR = path.join(workDir, 'output');
const FFMPEG = 'ffmpeg';
const MAIN = path.join(workDir, 'main-video.MP4');
const MIDDLE_SLIDESHOW = path.join(OUTPUT_DIR, 'middle-slideshow.mp4');
const MIDDLE_VIDEO = path.join(workDir, 'middle-video.mp4');
const MIDDLE = fs.existsSync(MIDDLE_SLIDESHOW) ? MIDDLE_SLIDESHOW : MIDDLE_VIDEO;
const STICKER = path.join(OUTPUT_DIR, 'bordered-image.png');
const AUDIO_FILE = path.join(workDir, 'barain.mp3');
const OUTPUT = path.join(OUTPUT_DIR, 'final-video.mp4');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function getDur(file) {
  const cmd = `${FFMPEG} -i "${file}" 2>&1 | grep Duration | cut -d' ' -f4 | cut -d',' -f1`;
  const dur = execSync(cmd).toString().trim();
  const [h,m,s] = dur.split(':').map(Number);
  return h*3600 + m*60 + s;
}

function main() {
  console.log('🎬 Creating CENTER-OUT curtain\n');
  console.log(`WorkDir: ${workDir}`);
  
  const middleSource = MIDDLE === MIDDLE_SLIDESHOW ? 'middle-slideshow' : 'middle-video';
  console.log(`Using: ${middleSource}\n`);
  
  const mainDur = getDur(MAIN);
  const midDur = getDur(MIDDLE);
  const total = mainDur + midDur;
  
  console.log(`Main: ${mainDur.toFixed(2)}s | Middle: ${midDur.toFixed(2)}s\n`);
  
  // Step 1: Extended main
  console.log('Step 1: Extended main...');
  const freezeDuration = total - mainDur;
  try {
    // Extract last frame
    execSync(`${FFMPEG} -i "${MAIN}" -ss ${mainDur - 0.1} -vframes 1 "${OUTPUT_DIR}/last-frame-for-loop.png" -y`, {stdio: 'inherit'});
    // Create looped video from last frame
    execSync(`${FFMPEG} -loop 1 -i "${OUTPUT_DIR}/last-frame-for-loop.png" -vf "fps=60,scale=1080:1920" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r 60 -t ${freezeDuration} "${OUTPUT_DIR}/freeze-extension.mp4" -y`, {stdio: 'inherit'});
    // Concatenate original + freeze using filter_complex instead of concat demuxer
    execSync(`${FFMPEG} -i "${MAIN}" -i "${OUTPUT_DIR}/freeze-extension.mp4" -filter_complex "[0:v]fps=60,scale=1080:1920[v0];[1:v]fps=60,scale=1080:1920[v1];[v0][v1]concat=n=2:v=1:a=0[out]" -map [out] -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r 60 "${OUTPUT_DIR}/extended-main.mp4" -y`, {stdio: 'inherit'});
    console.log('✓ Done\n');
  } catch (err) {
    console.error('❌ Step 1 failed:', err.message);
    throw err;
  }
  
  // Step 2: Center-out using frozen main frame as background
  console.log('Step 2: Center-out curtain (frozen main frame bg)...');
  
  try {
    // Scale middle first
    execSync(`${FFMPEG} -i "${MIDDLE}" -vf "fps=60,scale=1080:1920" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r 60 -t ${midDur} "${OUTPUT_DIR}/middle-scaled.mp4" -y`, {stdio: 'inherit'});
    
    // Extract frozen frame from extended main and loop it with proper colorspace
    execSync(`${FFMPEG} -i "${OUTPUT_DIR}/extended-main.mp4" -ss ${mainDur - 0.1} -vframes 1 "${OUTPUT_DIR}/frozen-frame.png" -y`, {stdio: 'inherit'});
    execSync(`${FFMPEG} -loop 1 -i "${OUTPUT_DIR}/frozen-frame.png" -vf "format=yuv420p,fps=60,scale=1080:1920" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r 60 -t ${midDur} "${OUTPUT_DIR}/frozen-bg.mp4" -y`, {stdio: 'inherit'});
    
    // Blend with expression - reveal from center expanding outward
    const centerY = 960; // 1920/2
    const halfH = 960;   // 1920/2
    
    execSync(`${FFMPEG} -i "${OUTPUT_DIR}/frozen-bg.mp4" -i "${OUTPUT_DIR}/middle-scaled.mp4" -filter_complex "` +
      `[0:v]format=yuv420p[bg];` +
      `[1:v]format=yuv420p[fg];` +
      `[bg][fg]blend=all_expr='` +
      `if(between(Y,${centerY}-(${halfH}*T/${midDur}),${centerY}+(${halfH}*T/${midDur})),B,A)'` +
      `:shortest=1[out]` +
      `" -map [out] -c:v libx264 -preset ultrafast -pix_fmt yuv420p -r 60 -t ${midDur} "${OUTPUT_DIR}/middle-curtain.mp4" -y`, {stdio: 'inherit'});
    console.log('✓ Done\n');
  } catch (err) {
    console.error('❌ Step 2 failed:', err.message);
    throw err;
  }
  
  // Step 3: Compose final with Camera Shake
  console.log('Step 3: Final composition with audio and shake...');
  try {
    const audioInput = fs.existsSync(AUDIO_FILE) ? `-stream_loop -1 -i "${AUDIO_FILE}"` : '';
    const audioMap = fs.existsSync(AUDIO_FILE) ? `-map [out_a] -c:a aac -b:a 192k` : '';
    const audioFilter = fs.existsSync(AUDIO_FILE) ? `;[3:a]anull[out_a]` : '';

    execSync(`${FFMPEG} -i "${OUTPUT_DIR}/extended-main.mp4" -i "${OUTPUT_DIR}/middle-curtain.mp4" -i "${STICKER}" ${audioInput} -filter_complex "` +
      `[0:v]fps=60,scale=1080:1920[v0];` +
      `[1:v]setpts=PTS+${mainDur}/TB,fps=60,scale=1080:1920[mid];` +
      // Smoother sticker animation with cubic easing approximation
      `[2:v]loop=-1:1,setpts=PTS+${mainDur}/TB,fps=60,scale='trunc(iw*max(0.6,1-pow(sin((t-${mainDur})/(${total}-${mainDur})*1.5708),2)*0.4)/2)*2:trunc(ih*max(0.6,1-pow(sin((t-${mainDur})/(${total}-${mainDur})*1.5708),2)*0.4)/2)*2':eval=frame[sticker];` +
      `[v0][mid]overlay=0:0:shortest=1[tmp];` +
      `[tmp][sticker]overlay=(W-w)/2:H-h:shortest=1[comp];` +
      // Add subtle camera shake effect
      `[comp]crop=iw-40:ih-40:20+15*sin(t*7):20+15*cos(t*9)[shake];` +
      `[shake]scale=1080:1920[out_v]${audioFilter}` +
      `" -map [out_v] ${audioMap} -c:v libx264 -pix_fmt yuv420p -r 60 -t ${total} "${OUTPUT}" -y`, {stdio: 'inherit'});
    
    console.log('\n✅ Done!');
    console.log(`🎉 ${OUTPUT}`);
  } catch (err) {
    console.error('❌ Step 3 failed:', err.message);
    throw err;
  }
}

main();
