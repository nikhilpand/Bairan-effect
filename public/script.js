document.addEventListener('DOMContentLoaded', () => {
    // Configuration
    const API_BASE_URL = ''; // EDIT THIS: e.g. 'https://your-backend.onrender.com'

    // Elements
    const generationForm = document.getElementById('generationForm');
    const videoInput = document.getElementById('videoInput');
    const photosInput = document.getElementById('photosInput');
    const videoName = document.getElementById('videoName');
    const photosName = document.getElementById('photosName');
    const submitBtn = document.getElementById('submitBtn');

    const uploadContainer = document.getElementById('uploadContainer');
    const processingContainer = document.getElementById('processingContainer');
    const statusTitle = document.getElementById('statusTitle');
    const requestIdDisplay = document.getElementById('requestId');
    const logContent = document.getElementById('logContent');
    const resultsArea = document.getElementById('resultsArea');
    const downloadBtn = document.getElementById('downloadBtn');

    // File selection display
    videoInput.addEventListener('change', () => {
        if (videoInput.files.length > 0) {
            videoName.textContent = videoInput.files[0].name;
        }
    });

    photosInput.addEventListener('change', () => {
        if (photosInput.files.length > 0) {
            photosName.textContent = `${photosInput.files.length} Magic Frames selected`;
        }
    });

    // Form Submission
    generationForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const formData = new FormData();
        formData.append('video', videoInput.files[0]);
        for (let i = 0; i < photosInput.files.length; i++) {
            formData.append('photos', photosInput.files[i]);
        }

        // UI Transition to Processing
        submitBtn.disabled = true;
        submitBtn.querySelector('.btn-text').textContent = "UPLOADING...";

        try {
            const response = await fetch(`${API_BASE_URL}/upload-and-process`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) throw new Error('Engine rejected the project');

            const { requestId } = await response.json();

            // Switch view
            uploadContainer.classList.add('hidden');
            processingContainer.classList.remove('hidden');
            requestIdDisplay.textContent = `ID: ${requestId}`;

            startPolling(requestId);

        } catch (error) {
            alert(error.message);
            submitBtn.disabled = false;
            submitBtn.querySelector('.btn-text').textContent = "START SYNTHESIS";
        }
    });

    function startPolling(requestId) {
        const interval = setInterval(async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/status/${requestId}`);
                if (!res.ok) return;
                const data = await res.json();

                if (data.progress !== undefined) {
                    updateUI(data.progress, data.message);
                    if (data.progress > 0 && data.progress < 100) {
                        updateTabTitle(true);
                    }
                }

                if (data.status === 'completed') {
                    clearInterval(interval);
                    updateTabTitle(false);
                    showFinalResult(data.result.fileUrl);
                    triggerSuccessSparkles();
                } else if (data.status === 'failed') {
                    clearInterval(interval);
                    handleFailure(data.error);
                }
            } catch (err) {
                console.error('Connection lost:', err);
            }
        }, 2000);
    }

    function handleFailure(error) {
        updateTabTitle(false);
        statusTitle.textContent = "Synthesis Failed";
        logContent.textContent = error || "Unknown engine error";
        submitBtn.disabled = false;
        submitBtn.querySelector('.btn-text').textContent = "RETRY SYNTHESIS";
    }

    function updateUI(percent, message) {
        if (message) logContent.textContent = message;

        // Update steps based on progress percentages
        const steps = ['extraction', 'segmentation', 'stitching', 'finalization'];
        const currentStepIdx = Math.floor(percent / 25);

        steps.forEach((step, idx) => {
            const el = document.getElementById(`step_${step}`);
            if (!el) return;

            el.classList.remove('active', 'done');
            if (idx < currentStepIdx) {
                el.classList.add('done');
            } else if (idx === currentStepIdx) {
                el.classList.add('active');
            }
        });

        // Dynamic Title
        if (percent < 25) statusTitle.textContent = "Extracting...";
        else if (percent < 50) statusTitle.textContent = "Segmenting...";
        else if (percent < 75) statusTitle.textContent = "Stitching...";
        else statusTitle.textContent = "Rendering...";
    }

    function showFinalResult(url) {
        statusTitle.textContent = "Synthesis Ready";
        logContent.textContent = "Project finalized successfully.";
        resultsArea.classList.remove('hidden');
        downloadBtn.href = url;
    }

    // Dynamic Scroll Animations
    const container = document.querySelector('.container');
    const hero = document.querySelector('.hero');
    const zenCard = document.querySelector('.zen-card');

    window.addEventListener('scroll', () => {
        const scrolled = window.pageYOffset;
        const rate = scrolled * 0.15;

        if (hero) {
            hero.style.transform = `translate3d(0px, ${rate}px, 0px)`;
            hero.style.opacity = 1 - (scrolled / 400);
        }

        if (zenCard) {
            const scale = Math.max(0.95, 1 - (scrolled / 2000));
            zenCard.style.transform = `scale(${scale})`;
            zenCard.style.boxShadow = `0 ${40 + (scrolled / 10)}px ${100 + (scrolled / 5)}px -20px rgba(0,0,0,0.05)`;
        }
    });

    // Welcome Screen & Studio Entrance
    const welcomeScreen = document.getElementById('welcomeScreen');
    const enterBtn = document.getElementById('enterBtn');
    const bgMusic = document.getElementById('bgMusic');
    const bgVideo = document.getElementById('bgVideo');

    if (enterBtn && welcomeScreen) {
        enterBtn.addEventListener('click', () => {
            console.log("Studio Entrance Triggered");
            welcomeScreen.classList.add('fade-out');

            // Trigger Studio Atmosphere
            if (bgMusic) {
                bgMusic.muted = false; // Just in case
                bgMusic.play().catch(e => console.error("Audio failed:", e));
            }
            if (bgVideo) {
                bgVideo.muted = true; // FORCE MUTE
                bgVideo.play().catch(e => console.error("Video failed:", e));
            }

            // Remove overlay from DOM after transition
            setTimeout(() => {
                welcomeScreen.remove();
                document.body.style.overflowY = 'auto'; // Re-enable scrolling
                initializeStudioDetails();
            }, 1200);
        });
    }

    function initializeStudioDetails() {
        // Custom Ethereal Cursor
        const cursor = document.createElement('div');
        cursor.className = 'custom-cursor';
        document.body.appendChild(cursor);

        document.addEventListener('mousemove', (e) => {
            requestAnimationFrame(() => {
                cursor.style.left = `${e.clientX - 10}px`;
                cursor.style.top = `${e.clientY - 10}px`;
            });
        });

        document.querySelectorAll('button, a, .drop-zone, input').forEach(el => {
            el.addEventListener('mouseenter', () => cursor.classList.add('hover'));
            el.addEventListener('mouseleave', () => cursor.classList.remove('hover'));
        });
    }

    function triggerSuccessSparkles() {
        const btn = document.getElementById('downloadBtn');
        const rect = btn.getBoundingClientRect();
        for (let i = 0; i < 30; i++) {
            const s = document.createElement('div');
            s.className = 'sparkle';
            s.style.background = ['#B5D5E3', '#DCA8AF', '#FFE5D9', '#FBF7D5'][Math.floor(Math.random() * 4)];
            s.style.left = `${rect.left + rect.width / 2}px`;
            s.style.top = `${rect.top + rect.height / 2}px`;
            s.style.setProperty('--tx', `${(Math.random() - 0.5) * 200}px`);
            s.style.setProperty('--ty', `${(Math.random() - 0.5) * 200}px`);
            document.body.appendChild(s);
            setTimeout(() => s.remove(), 1500);
        }
    }

    // Dynamic Tab Logic
    const originalTitle = document.title;
    function updateTabTitle(isProcessing) {
        document.title = isProcessing ? `✨ Rendering... | Bairan` : originalTitle;
    }

    // Audio Controls
    const muteBtn = document.getElementById('muteBtn');
    const volumeSlider = document.getElementById('volumeSlider');

    if (bgMusic && muteBtn && volumeSlider) {
        bgMusic.volume = volumeSlider.value;

        muteBtn.addEventListener('click', () => {
            bgMusic.muted = !bgMusic.muted;
            muteBtn.textContent = bgMusic.muted ? '🔇' : '🔊';
        });

        volumeSlider.addEventListener('input', (e) => {
            bgMusic.volume = e.target.value;
            if (bgMusic.volume > 0) {
                bgMusic.muted = false;
                muteBtn.textContent = '🔊';
            } else {
                bgMusic.muted = true;
                muteBtn.textContent = '🔇';
            }
        });
    }
});
