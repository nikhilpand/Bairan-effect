const express = require('express');
const cors = require('cors');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const FormData = require('form-data');
const multer = require('multer');
const TASKS_FILE = 'tasks.json';
let tasks = {};

// Load tasks from file if it exists
if (fs.existsSync(TASKS_FILE)) {
  try {
    tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    console.log(`Loaded ${Object.keys(tasks).length} tasks from ${TASKS_FILE}`);
  } catch (err) {
    console.error('Failed to load tasks.json:', err.message);
    tasks = {};
  }
}

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.static('public')); // Serve frontend
app.use('/output', express.static(path.join(__dirname, 'output')));

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const TEMP_BASE_DIR = 'temp-requests';
let isProcessing = false; 
const processingQueue = [];

console.log('--- SYSTEM CHECK ---');
console.log(`FFMPEG_PATH: ${process.env.FFMPEG_PATH || '(not set - using default "ffmpeg")'}`);
console.log(`FFPROBE_PATH: ${process.env.FFPROBE_PATH || '(not set - using default "ffprobe")'}`);
if (process.env.FFMPEG_PATH && !fs.existsSync(process.env.FFMPEG_PATH)) {
  console.log('⚠️ WARNING: FFMPEG_PATH points to a file that does NOT exist on disk!');
}
console.log('--------------------');

/**
 * Update task status locally
 */
function updateTaskStatus(requestId, data) {
  if (!tasks[requestId]) tasks[requestId] = { createdAt: Date.now() };
  tasks[requestId] = { ...tasks[requestId], ...data, updatedAt: Date.now() };
  
  // Persist to file
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  } catch (err) {
    console.error('Failed to save tasks.json:', err.message);
  }

  // Log to server console so user can see it
  console.log(`[ID: ${requestId}] -> ${data.status} | ${data.message || ''}`);
}

if (!fs.existsSync(TEMP_BASE_DIR)) fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

// Auto-cleanup old requests every 30 minutes
setInterval(() => {
  console.log('🧹 Running auto-cleanup of old temporary requests...');
  try {
    const folders = fs.readdirSync(TEMP_BASE_DIR);
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour

    folders.forEach(folder => {
      const folderPath = path.join(TEMP_BASE_DIR, folder);
      const stats = fs.statSync(folderPath);
      if (now - stats.mtimeMs > maxAge) {
        console.log(`🗑️ Deleting expired request folder: ${folder}`);
        fs.rmSync(folderPath, { recursive: true, force: true });
      }
    });
  } catch (err) {
    console.error('❌ Cleanup failed:', err.message);
  }
}, 30 * 60 * 1000);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!req.requestId) {
        req.requestId = generateRequestId();
        console.log(`Debug: Generated NEW requestId: ${req.requestId}`);
    } else {
        console.log(`Debug: Reusing requestId: ${req.requestId} for file ${file.originalname}`);
    }
    const requestId = req.requestId; // Attach requestId to request object
    const workDir = path.join(TEMP_BASE_DIR, requestId);
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
    
    if (file.fieldname === 'video') {
      cb(null, workDir);
    } else {
      const imagesDir = path.join(workDir, 'middle-images');
      if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
      cb(null, imagesDir);
    }
  },
  filename: (req, file, cb) => {
    if (file.fieldname === 'video') {
      cb(null, 'input-video' + path.extname(file.originalname));
    } else {
      cb(null, file.originalname);
    }
  }
});

const upload = multer({ storage: storage });

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function prepareDownloadLink(filePath, requestId) {
  const downloadFilename = `final_${requestId}.mp4`;
  const publicUrl = `/output/${downloadFilename}`;
  return { fileUrl: publicUrl, fileId: 'local' };
}

function extractZip(zipPath, destDir) {
  console.log(`Extracting zip: ${zipPath}`);
  execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'inherit' });
  
  const files = fs.readdirSync(destDir);
  console.log(`Extracted ${files.length} files`);
}

function runStep(stepNum, workDir) {
  return new Promise((resolve, reject) => {
    let scriptName;
    if (stepNum === 1) scriptName = 'step1-extract-last-frame.js';
    else if (stepNum === 2) scriptName = 'step2-remove-background.js';
    else if (stepNum === 3) scriptName = 'step3-add-borders.js';
    else if (stepNum === 4) scriptName = 'step4-compose-video.js';
    
    console.log(`Running step ${stepNum}: ${scriptName}`);
    
    let errorData = '';
    const proc = spawn('node', [scriptName, workDir], { 
      cwd: __dirname,
      stdio: ['inherit', 'inherit', 'pipe'], // Inheritance for out, pipe for err
      env: process.env
    });

    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        errorData += chunk.toString();
        process.stderr.write(chunk); // Still show in terminal
      });
    }
    
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const msg = errorData.length > 0 ? errorData.split('\n').filter(l => l.trim()).slice(-2).join(' | ') : `Code ${code}`;
        reject(new Error(`Step ${stepNum} failed: ${msg}`));
      }
    });
  });
}

async function processVideo(videoPath, isUrl = false, zipPath = null, zipUrl = false, userId = null, imageUrls = null, existingWorkDir = null) {
  const requestId = existingWorkDir ? path.basename(existingWorkDir) : generateRequestId();
  const effectiveUserId = userId || requestId;
  const workDir = existingWorkDir || path.join(TEMP_BASE_DIR, requestId);
  const imagesDir = path.join(workDir, 'middle-images');
  const outputDir = path.join(workDir, 'output');
  
  if (!existingWorkDir) {
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
  }
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  
  console.log(`Work directory: ${workDir}`);
  
  try {
    const tempZip = path.join(workDir, 'input-images.zip');
    const middleSlideshow = path.join(outputDir, 'middle-slideshow.mp4');
    
    if (zipPath) {
      if (zipUrl) {
        console.log(`Downloading zip from: ${zipPath}`);
        await downloadFile(zipPath, tempZip);
        zipPath = tempZip;
      }
      
      if (!fs.existsSync(zipPath)) {
        throw new Error(`Zip file not found: ${zipPath}`);
      }
      
      console.log(`Extracting images from zip: ${zipPath}`);
      extractZip(zipPath, imagesDir);
      
      if (zipUrl && fs.existsSync(tempZip)) {
        fs.unlinkSync(tempZip);
      }
      
      console.log('Creating slideshow from images...');
      await new Promise((resolve, reject) => {
        const proc = spawn('node', ['create-middle-slideshow.js', imagesDir, middleSlideshow], { 
          cwd: __dirname,
          stdio: 'inherit' 
        });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Slideshow creation failed with code ${code}`));
        });
      });
    } else if (imageUrls && imageUrls.length > 0) {
      console.log(`Downloading ${imageUrls.length} images...`);
      for (let i = 0; i < imageUrls.length; i++) {
        const imageUrl = imageUrls[i];
        const ext = path.extname(new URL(imageUrl).pathname).split('?')[0] || '.jpg';
        const destPath = path.join(imagesDir, `image_${String(i).padStart(3, '0')}${ext}`);
        console.log(`Downloading image ${i + 1}/${imageUrls.length}: ${imageUrl}`);
        await downloadFile(imageUrl, destPath);
      }
      
      console.log('Creating slideshow from images...');
      await new Promise((resolve, reject) => {
        const proc = spawn('node', ['create-middle-slideshow.js', imagesDir, middleSlideshow], { 
          cwd: __dirname,
          stdio: 'inherit',
          env: process.env
        });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Slideshow creation failed with code ${code}`));
        });
      });
    } else if (fs.existsSync(imagesDir) && fs.readdirSync(imagesDir).length > 0) {
      // Case where images were already uploaded via multer
      console.log('Using uploaded images for slideshow...');
      await new Promise((resolve, reject) => {
        const proc = spawn('node', ['create-middle-slideshow.js', imagesDir, middleSlideshow], { 
          cwd: __dirname,
          stdio: 'inherit',
          env: process.env
        });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Slideshow creation failed with code ${code}`));
        });
      });
    }
    
    const tempVideo = path.join(workDir, 'input-video.mp4');
    
    if (isUrl) {
      console.log(`Downloading video from: ${videoPath}`);
      await downloadFile(videoPath, tempVideo);
      videoPath = tempVideo;
    } else if (!existingWorkDir) {
      if (!fs.existsSync(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
      }
    } else {
        // Find whichever video file multer saved
        const files = fs.readdirSync(workDir);
        console.log(`Debug: Files in workDir ${requestId}:`, files);
        const videoFile = files.find(f => f.startsWith('input-video'));
        if (videoFile) {
            videoPath = path.join(workDir, videoFile);
            console.log(`Debug: Found video at ${videoPath}`);
        }
        else throw new Error('No uploaded video found');
    }

    console.log(`Processing: ${videoPath}`);
    
    const ext = path.extname(videoPath).toLowerCase();
    if (!['.mp4', '.mov', '.avi'].includes(ext)) {
      throw new Error('Unsupported video format. Use MP4, MOV, or AVI.');
    }

    const ffmpegPath = path.resolve(FFMPEG);
    if (!fs.existsSync(ffmpegPath)) {
      throw new Error(`CRITICAL: FFmpeg binary not found at absolute path: ${ffmpegPath}`);
    }
    const mainVideo = path.join(workDir, 'main-video.MP4');
    
    await updateTaskStatus(requestId, { status: 'converting', progress: 20 });
    console.log(`Converting: ${videoPath} -> ${mainVideo}`);
    
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        '-i', videoPath,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-threads', '1', // Limit threads to save memory
        '-y',
        mainVideo
      ], { 
        stdio: ['ignore', 'ignore', 'pipe'], // Standard out ignore, pipe err
        env: process.env 
      });

      let errData = '';
      if (proc.stderr) {
        proc.stderr.on('data', (data) => {
          errData += data.toString();
        });
      }

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Video conversion failed (code ${code}): ${errData.slice(-100)}`));
      });
    });
    
    console.log(`✅ Converted to MP4: ${mainVideo}`);

    await updateTaskStatus(requestId, { status: 'extracting_frame', progress: 40 });
    await runStep(1, workDir);
    
    await updateTaskStatus(requestId, { status: 'removing_bg', progress: 60 });
    await runStep(2, workDir);
    
    await updateTaskStatus(requestId, { status: 'adding_borders', progress: 75 });
    await runStep(3, workDir);
    
    await updateTaskStatus(requestId, { status: 'composing_video', progress: 90 });
    await runStep(4, workDir);

    const finalVideo = path.join(outputDir, 'final-video.mp4');
    
    // Save to global output for download
    const globalOutputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(globalOutputDir)) fs.mkdirSync(globalOutputDir);
    const downloadFilename = `final_${requestId}.mp4`;
    const downloadPath = path.join(globalOutputDir, downloadFilename);
    fs.copyFileSync(finalVideo, downloadPath);

    console.log('Finalizing video for local download...');
    const result = await prepareDownloadLink(finalVideo, requestId);
    
    if (isUrl && fs.existsSync(tempVideo)) {
      fs.unlinkSync(tempVideo);
    }

    fs.rmSync(workDir, { recursive: true, force: true });
    console.log(`Cleaned up work directory: ${requestId}`);

    return {
      success: true,
      fileUrl: result.fileUrl,
      downloadUrl: `/output/${downloadFilename}`,
      requestId: requestId
    };
  } catch (error) {
    console.error('Error:', error.message);
    if (fs.existsSync(workDir)) {
      // fs.rmSync(workDir, { recursive: true, force: true });
    }
    throw error;
  }
}

app.post('/process', async (req, res) => {
  try {
    const { videoPath, isUrl, zipPath, zipUrl, userId, imageUrls } = req.body;
    if (!videoPath) return res.status(400).json({ error: 'videoPath is required' });
    const result = await processVideo(videoPath, isUrl, zipPath, zipUrl, userId, imageUrls);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/upload-and-process', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'photos', maxCount: 100 }
]), (req, res) => {
  const requestId = req.requestId;
  if (!requestId) return res.status(400).json({ error: 'No files uploaded' });
  const workDir = path.join(TEMP_BASE_DIR, requestId);

  updateTaskStatus(requestId, { status: 'queued', progress: 0, message: 'Request received.' });

  const processTask = async () => {
    try {
      updateTaskStatus(requestId, { status: 'processing', progress: 10 });
      const result = await processVideo(null, false, null, false, null, null, workDir);
      updateTaskStatus(requestId, { status: 'completed', progress: 100, result: result });
      return result;
    } catch (error) {
       updateTaskStatus(requestId, { status: 'failed', error: error.message });
    }
  };

  processingQueue.push({ task: processTask, resolve: () => {}, reject: () => {} });
  
  if (!isProcessing) {
    (async function runNext() {
      if (processingQueue.length === 0) { isProcessing = false; return; }
      isProcessing = true;
      const { task } = processingQueue.shift();
      await task();
      runNext();
    })();
  }

  res.json({ success: true, requestId, status: 'queued' });
});

app.get('/status/:requestId', (req, res) => {
  const task = tasks[req.params.requestId];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

app.use((err, req, res, next) => {
  console.error('SERVER ERROR:', err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3006;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Local Engine running on port ${PORT}`);
});
