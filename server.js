const express = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const FormData = require('form-data');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.static('public')); // Serve frontend

const FFMPEG = 'ffmpeg';
const TEMP_BASE_DIR = 'temp-requests';
let isProcessing = false; // Simple lock for sequential processing to avoid OOM in cloud
const processingQueue = [];

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

async function uploadToStoreFile(filePath, userId) {
  let url = process.env.STORAGE_URL; // Fixed: use STORAGE_URL instead of PORT
  if (!url || url === '{api_url/store-file}') {
     console.warn('STORAGE_URL not set or default. Using local fallback.');
     return { fileUrl: `/download/${path.basename(filePath)}`, fileId: 'local' };
  }
  
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('userid', userId);
    
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname,
      method: 'POST',
      headers: form.getHeaders()
    };
    
    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        } else {
          reject(new Error(`Upload failed with status ${res.statusCode}: ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    form.pipe(req);
  });
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
    
    const proc = spawn('node', [scriptName, workDir], { 
      cwd: __dirname,
      stdio: 'inherit' 
    });
    
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Step ${stepNum} failed with code ${code}`));
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
          stdio: 'inherit' 
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
          stdio: 'inherit' 
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

    const mainVideo = path.join(workDir, 'main-video.MP4');
    
    // Convert video to MP4 format
    console.log(`Converting to MP4: ${videoPath}`);
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-i', videoPath,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-y',
        mainVideo
      ], { stdio: 'inherit' });
      proc.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ Converted to MP4: ${mainVideo}`);
          resolve();
        } else {
          reject(new Error(`Video conversion failed with code ${code}`));
        }
      });
    });

    await runStep(1, workDir);
    await runStep(2, workDir);
    await runStep(3, workDir);
    await runStep(4, workDir);

    const finalVideo = path.join(outputDir, 'final-video.mp4');
    
    // Save to global output for download
    const globalOutputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(globalOutputDir)) fs.mkdirSync(globalOutputDir);
    const downloadFilename = `final_${requestId}.mp4`;
    const downloadPath = path.join(globalOutputDir, downloadFilename);
    fs.copyFileSync(finalVideo, downloadPath);

    console.log('Uploading/Readying final video...');
    const uploadResult = await uploadToStoreFile(finalVideo, effectiveUserId);
    
    if (isUrl && fs.existsSync(tempVideo)) {
      fs.unlinkSync(tempVideo);
    }

    fs.rmSync(workDir, { recursive: true, force: true });
    console.log(`Cleaned up work directory: ${requestId}`);

    return {
      success: true,
      fileUrl: uploadResult.fileUrl,
      downloadUrl: `/download/${downloadFilename}`,
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
  { name: 'photos', maxCount: 20 }
]), async (req, res) => {
  const requestId = req.requestId;
  if (!requestId) return res.status(400).json({ error: 'No files uploaded' });
  const workDir = path.join(TEMP_BASE_DIR, requestId);

  // Add to queue logic
  const processTask = async () => {
    try {
      console.log(`🚀 Starting processing for ${requestId}...`);
      const result = await processVideo(null, false, null, false, null, null, workDir);
      return result;
    } catch (error) {
       console.error(`❌ Error processing ${requestId}:`, error.message);
       throw error;
    }
  };

  // Simple sequential queue runner
  const runNextTask = async () => {
    if (isProcessing || processingQueue.length === 0) return;
    isProcessing = true;
    const { task, resolve, reject } = processingQueue.shift();
    try {
      const res = await task();
      resolve(res);
    } catch (e) {
      reject(e);
    } finally {
      isProcessing = false;
      runNextTask(); // Run next in queue
    }
  };

  try {
    // Wrap task in a promise to wait for its turn in the queue
    const result = await new Promise((resolve, reject) => {
      processingQueue.push({ task: processTask, resolve, reject });
      runNextTask();
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(__dirname, 'output', filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.download(filepath);
});

app.get('/status', (req, res) => {
  res.json({ status: 'running' });
});

const PORT = process.env.PORT || process.env.PORT_SERVER || 3005;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
