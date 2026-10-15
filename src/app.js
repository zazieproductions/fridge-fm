import JSZip from 'jszip';
window.JSZip = JSZip;
(function() {
        'use strict';

        // =========================================================================
        // 1. SEEDED PSEUDO-RANDOM GENERATOR (Mulberry32 + String Hash)
        // =========================================================================
        class SeededRandom {
            constructor(seedStr = 'CRYO-1958') {
                this.setSeed(seedStr);
            }
            setSeed(seedStr) {
                this.seedStr = String(seedStr);
                let h = 1779033703 ^ this.seedStr.length;
                for (let i = 0; i < this.seedStr.length; i++) {
                    h = Math.imul(h ^ this.seedStr.charCodeAt(i), 3432918353);
                    h = (h << 13) | (h >>> 19);
                }
                this.state = (h >>> 0) || 123456789;
            }
            next() {
                let t = (this.state += 0x6D2B79F5);
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            }
            range(min, max) {
                return min + this.next() * (max - min);
            }
            choice(arr) {
                return arr[Math.floor(this.next() * arr.length)];
            }
        }

        // =========================================================================
        // 2. GLOBAL SYNTHESIZER STATE & INSTRUMENT PARAMETERS
        // =========================================================================
        const state = {
            powered: false,
            doorOpen: true,
            thermostat: 62, // 0 = Warm Analog (12°C), 100 = Deep Cryo (-24°C)
            masterVolume: 0.80,
            activeInstrument: 'compressor',
            octave: 4,
            seed: 'CRYO-1958',
            rng: new SeededRandom('CRYO-1958'),
            compressorRunning: false,
            compressorRPM: 48,
            humRunning: false,
            defrostHissRunning: false,
            iceMakerAuto: false,
            seqPlaying: false,
            bpm: 118,
            density: 65,
            currentStep: 0,
            frozenBufferActive: false,
            hauntedMode: false,

            // 6 Glass Bottles liquid fill (0.1 to 0.95) -> governs modal pitch
            bottleLevels: [0.18, 0.32, 0.48, 0.62, 0.76, 0.90],
            // 8 Ice Cube harmonic ratios
            iceCubeRatios: [1.0, 1.26, 1.414, 1.618, 1.88, 2.15, 2.52, 3.14],
            // 16 Sequencer steps
            seqSteps: [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1],

            // 8 Tactile Synth Knobs (0..1 normalized)
            params: {
                pitch: 0.50,      // Base Frequency offset
                timbre: 0.58,     // FM Index / Harmonic brightness
                modDepth: 0.45,   // LFO / Instability modulation depth
                resonance: 0.40,  // Filter Q / Modal decay ringing
                decay: 0.55,      // Envelope release / tail
                drive: 0.28,      // Saturation / Thermal grit
                stereo: 0.65,     // Panning width
                cryoMix: 0.50     // Spectral ice shimmer
            },

            fx: {
                delayFeedback: 0.35,
                delayTime: 0.28,
                reverbMix: 0.42
            }
        };

        // Specific Presets per Fridge Component / Aesthetic
        const PRESETS = {
            default: {
                thermostat: 62,
                params: { pitch: 0.50, timbre: 0.58, modDepth: 0.45, resonance: 0.40, decay: 0.55, drive: 0.28, stereo: 0.65, cryoMix: 0.50 }
            },
            subzero: {
                thermostat: 96,
                params: { pitch: 0.72, timbre: 0.88, modDepth: 0.65, resonance: 0.82, decay: 0.80, drive: 0.15, stereo: 0.90, cryoMix: 0.95 }
            },
            rusty1958: {
                thermostat: 18,
                params: { pitch: 0.25, timbre: 0.42, modDepth: 0.78, resonance: 0.35, decay: 0.62, drive: 0.82, stereo: 0.40, cryoMix: 0.15 }
            },
            freonleak: {
                thermostat: 74,
                params: { pitch: 0.44, timbre: 0.92, modDepth: 0.85, resonance: 0.88, decay: 0.75, drive: 0.55, stereo: 0.85, cryoMix: 0.78 }
            },
            midnightmilk: {
                thermostat: 52,
                params: { pitch: 0.55, timbre: 0.32, modDepth: 0.22, resonance: 0.76, decay: 0.70, drive: 0.08, stereo: 0.75, cryoMix: 0.60 }
            },
            hyperidm: {
                thermostat: 84,
                params: { pitch: 0.64, timbre: 0.79, modDepth: 0.90, resonance: 0.65, decay: 0.22, drive: 0.48, stereo: 0.95, cryoMix: 0.82 }
            }
        };

        // =========================================================================
        // 3. CORE WEB AUDIO & AUDIOWORKLET SOUND ENGINE
        // =========================================================================
        class FridgeSynthEngine {
            constructor() {
                this.ctx = null;
                this.workletReady = false;
                this.masterGain = null;
                this.doorFilter = null;
                this.compressorBus = null;
                this.analyser = null;
                this.delayL = null;
                this.delayR = null;
                this.delayFeedbackNode = null;
                this.reverbConvolver = null;
                this.reverbWetGain = null;

                // Continuous Drone Nodes
                this.compressorDrone = null;
                this.humDrone = null;
                this.defrostNode = null;
                this.freezeLoopNode = null;
            }

            async init() {
                if (this.ctx) {
                    if (this.ctx.state === 'suspended') await this.ctx.resume();
                    return;
                }
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                this.ctx = new AudioCtx({ sampleRate: 48000 });

                // Load Custom Cryo-Crackle & Granular Frost AudioWorklet
                await this.registerCryoWorklet(this.ctx);

                // Master Chain: VoiceBus -> Saturation -> DoorFilter -> FX(Delay + Reverb) -> DynamicsCompressor -> MasterGain -> Analyser -> Destination
                this.voiceBus = this.ctx.createGain();
                this.voiceBus.gain.value = 0.9;

                this.driveNode = this.ctx.createWaveShaper();
                this.updateDriveCurve(state.params.drive);

                // Door Acoustic Filter (Open = 19000Hz, Closed = 380Hz muffled resonance)
                this.doorFilter = this.ctx.createBiquadFilter();
                this.doorFilter.type = 'lowpass';
                this.doorFilter.frequency.value = 19000;
                this.doorFilter.Q.value = 1.2;

                // Stereo Ping-Pong Delay
                this.delayL = this.ctx.createDelay(2.0);
                this.delayR = this.ctx.createDelay(2.0);
                this.delayL.delayTime.value = state.fx.delayTime;
                this.delayR.delayTime.value = state.fx.delayTime * 1.33;

                this.delayFeedbackNode = this.ctx.createGain();
                this.delayFeedbackNode.gain.value = state.fx.delayFeedback;

                const delayMerger = this.ctx.createChannelMerger(2);
                this.delayWet = this.ctx.createGain();
                this.delayWet.gain.value = 0.35;

                // Connect Ping-Pong loop
                this.doorFilter.connect(this.delayL);
                this.delayL.connect(this.delayR);
                this.delayR.connect(this.delayFeedbackNode);
                this.delayFeedbackNode.connect(this.delayL);

                this.delayL.connect(delayMerger, 0, 0);
                this.delayR.connect(delayMerger, 0, 1);
                delayMerger.connect(this.delayWet);

                // Algorithmic Cryo-Reverb Convolver
                this.reverbConvolver = this.ctx.createConvolver();
                this.reverbConvolver.buffer = this.generateCryoImpulse(this.ctx, 3.2, 2.6);
                this.reverbWetGain = this.ctx.createGain();
                this.reverbWetGain.gain.value = state.fx.reverbMix;

                this.doorFilter.connect(this.reverbConvolver);
                this.reverbConvolver.connect(this.reverbWetGain);

                // Master Limiter / Bus Compressor
                this.limiter = this.ctx.createDynamicsCompressor();
                this.limiter.threshold.value = -6;
                this.limiter.knee.value = 8;
                this.limiter.ratio.value = 8;
                this.limiter.attack.value = 0.003;
                this.limiter.release.value = 0.15;

                this.masterGain = this.ctx.createGain();
                this.masterGain.gain.value = state.masterVolume;

                this.analyser = this.ctx.createAnalyser();
                this.analyser.fftSize = 2048;
                this.analyser.smoothingTimeConstant = 0.82;

                // Final Routing
                this.voiceBus.connect(this.driveNode);
                this.driveNode.connect(this.doorFilter);
                this.doorFilter.connect(this.limiter);
                this.delayWet.connect(this.limiter);
                this.reverbWetGain.connect(this.limiter);
                this.limiter.connect(this.masterGain);
                this.masterGain.connect(this.analyser);
                this.analyser.connect(this.ctx.destination);

                // Start default ambient Fridge Hum for immediate immersion
                this.toggleHumDrone(true);
            }

            async registerCryoWorklet(audioCtx) {
                if (!audioCtx.audioWorklet) return;
                const workletCode = `
                    class CryoTextureProcessor extends AudioWorkletProcessor {
                        static get parameterDescriptors() {
                            return [
                                { name: 'density', defaultValue: 0.4, minValue: 0.0, maxValue: 1.0 },
                                { name: 'crackle', defaultValue: 0.6, minValue: 0.0, maxValue: 1.0 },
                                { name: 'frostTone', defaultValue: 0.5, minValue: 0.0, maxValue: 1.0 }
                            ];
                        }
                        constructor() {
                            super();
                            this.lp = 0;
                            this.bp = 0;
                            this.seed = 2463534242;
                        }
                        rand() {
                            this.seed ^= this.seed << 13;
                            this.seed ^= this.seed >>> 17;
                            this.seed ^= this.seed << 5;
                            return ((this.seed >>> 0) / 4294967296) * 2 - 1;
                        }
                        process(inputs, outputs, parameters) {
                            const out = outputs[0];
                            const density = parameters.density[0];
                            const crackle = parameters.crackle[0];
                            const tone = parameters.frostTone[0];
                            const f = 0.05 + tone * 0.35;
                            for (let ch = 0; ch < out.length; ch++) {
                                const channel = out[ch];
                                for (let i = 0; i < channel.length; i++) {
                                    const white = this.rand() * 0.18 * density;
                                    // State-variable filter for icy hiss
                                    this.lp += f * this.bp;
                                    const hp = white - this.lp - 0.25 * this.bp;
                                    this.bp += f * hp;
                                    // Stochastic frost micro-impulses
                                    let pop = 0;
                                    if (Math.abs(this.rand()) > (0.9985 - crackle * 0.008)) {
                                        pop = this.rand() * 0.85 * crackle;
                                    }
                                    channel[i] = (this.bp * 0.7 + hp * 0.3 + pop) * 0.5;
                                }
                            }
                            return true;
                        }
                    }
                    registerProcessor('cryo-texture-processor', CryoTextureProcessor);
                `;
                try {
                    const blob = new Blob([workletCode], { type: 'application/javascript' });
                    const url = URL.createObjectURL(blob);
                    await audioCtx.audioWorklet.addModule(url);
                    URL.revokeObjectURL(url);
                    this.workletReady = true;
                } catch (e) {
                    this.workletReady = false;
                }
            }

            generateCryoImpulse(ctx, duration = 3.0, decay = 2.4) {
                const rate = ctx.sampleRate;
                const length = Math.floor(rate * duration);
                const impulse = ctx.createBuffer(2, length, rate);
                const rng = new SeededRandom(state.seed + '-IR');
                for (let ch = 0; ch < 2; ch++) {
                    const data = impulse.getChannelData(ch);
                    for (let i = 0; i < length; i++) {
                        const t = i / length;
                        const env = Math.pow(1 - t, decay);
                        // Add subtle metallic refrigerator cavity reflections
                        const early = (i % 193 < 4) ? 1.35 : 1.0;
                        data[i] = (rng.next() * 2 - 1) * env * early * 0.5;
                    }
                }
                return impulse;
            }

            updateDriveCurve(amount) {
                if (!this.driveNode) return;
                const k = Math.max(0.01, amount) * 55;
                const samples = 1024;
                const curve = new Float32Array(samples);
                const deg = Math.PI / 180;
                for (let i = 0; i < samples; i++) {
                    const x = (i * 2) / samples - 1;
                    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
                }
                this.driveNode.curve = curve;
                this.driveNode.oversample = '2x';
            }

            updateDoorFilter(isOpen) {
                if (!this.doorFilter || !this.ctx) return;
                const now = this.ctx.currentTime;
                const targetFreq = isOpen ? 19000 : 380;
                const targetQ = isOpen ? 1.1 : 4.2;
                this.doorFilter.frequency.setTargetAtTime(targetFreq, now, 0.08);
                this.doorFilter.Q.setTargetAtTime(targetQ, now, 0.08);
            }

            updateThermostatDSP() {
                if (!this.ctx) return;
                const coldFactor = state.thermostat / 100; // 0 = warm, 1 = frozen
                // Adjust live drones if active
                if (this.compressorDrone) {
                    const now = this.ctx.currentTime;
                    const baseHz = state.compressorRPM * (1.1 - coldFactor * 0.25);
                    this.compressorDrone.carrier.frequency.setTargetAtTime(baseHz, now, 0.1);
                    this.compressorDrone.modGain.gain.setTargetAtTime(30 + coldFactor * 180 + state.params.timbre * 120, now, 0.1);
                }
            }

            // =========================================================================
            // CONTINUOUS GENERATIVE DRONES (COMPRESSOR, HUM, DEFROST)
            // =========================================================================
            toggleCompressorDrone(forceState) {
                if (!this.ctx) return;
                const nextState = forceState !== undefined ? forceState : !state.compressorRunning;
                state.compressorRunning = nextState;

                const now = this.ctx.currentTime;
                if (!nextState && this.compressorDrone) {
                    this.compressorDrone.outGain.gain.setTargetAtTime(0.0001, now, 0.15);
                    const old = this.compressorDrone;
                    setTimeout(() => {
                        try {
                            old.carrier.stop();
                            old.subOsc.stop();
                            old.modOsc.stop();
                            old.lfo.stop();
                        } catch (e) {}
                    }, 300);
                    this.compressorDrone = null;
                    return false;
                }

                if (nextState && !this.compressorDrone) {
                    const carrier = this.ctx.createOscillator();
                    const subOsc = this.ctx.createOscillator();
                    const modOsc = this.ctx.createOscillator();
                    const lfo = this.ctx.createOscillator();

                    const modGain = this.ctx.createGain();
                    const lfoGain = this.ctx.createGain();
                    const filter = this.ctx.createBiquadFilter();
                    const outGain = this.ctx.createGain();

                    const baseHz = state.compressorRPM;
                    carrier.type = 'sawtooth';
                    carrier.frequency.value = baseHz;

                    subOsc.type = 'triangle';
                    subOsc.frequency.value = baseHz * 0.5;

                    // Non-integer industrial FM ratio
                    modOsc.type = 'sine';
                    modOsc.frequency.value = baseHz * 1.414;
                    modGain.gain.value = 45 + state.params.timbre * 140;

                    // Mechanical piston wobble LFO
                    lfo.type = 'sine';
                    lfo.frequency.value = 3.2 + (baseHz / 25);
                    lfoGain.gain.value = 4.5 + state.params.modDepth * 14;

                    filter.type = 'bandpass';
                    filter.frequency.value = 140 + state.params.timbre * 450;
                    filter.Q.value = 2.5 + state.params.resonance * 6;

                    outGain.gain.setValueAtTime(0.001, now);
                    outGain.gain.exponentialRampToValueAtTime(0.28, now + 0.25);

                    modOsc.connect(modGain);
                    modGain.connect(carrier.frequency);
                    lfo.connect(lfoGain);
                    lfoGain.connect(filter.frequency);

                    carrier.connect(filter);
                    subOsc.connect(outGain);
                    filter.connect(outGain);
                    outGain.connect(this.voiceBus);

                    carrier.start(now);
                    subOsc.start(now);
                    modOsc.start(now);
                    lfo.start(now);

                    this.compressorDrone = { carrier, subOsc, modOsc, lfo, modGain, lfoGain, filter, outGain };
                }
                return state.compressorRunning;
            }

            setCompressorRPM(rpm) {
                state.compressorRPM = rpm;
                if (this.compressorDrone && this.ctx) {
                    const now = this.ctx.currentTime;
                    this.compressorDrone.carrier.frequency.setTargetAtTime(rpm, now, 0.06);
                    this.compressorDrone.subOsc.frequency.setTargetAtTime(rpm * 0.5, now, 0.06);
                    this.compressorDrone.modOsc.frequency.setTargetAtTime(rpm * (1.414 + state.params.timbre * 0.5), now, 0.06);
                    this.compressorDrone.lfo.frequency.setTargetAtTime(2.0 + rpm / 18, now, 0.06);
                }
            }

            toggleHumDrone(forceState) {
                if (!this.ctx) return;
                const nextState = forceState !== undefined ? forceState : !state.humRunning;
                state.humRunning = nextState;

                const now = this.ctx.currentTime;
                if (!nextState && this.humDrone) {
                    this.humDrone.gain.gain.setTargetAtTime(0.0001, now, 0.15);
                    const old = this.humDrone;
                    setTimeout(() => {
                        try { old.osc1.stop(); old.osc2.stop(); old.osc3.stop(); } catch (e) {}
                    }, 250);
                    this.humDrone = null;
                    return false;
                }

                if (nextState && !this.humDrone) {
                    const osc1 = this.ctx.createOscillator();
                    const osc2 = this.ctx.createOscillator();
                    const osc3 = this.ctx.createOscillator();
                    const lp = this.ctx.createBiquadFilter();
                    const gain = this.ctx.createGain();

                    osc1.type = 'sine';
                    osc2.type = 'triangle';
                    osc3.type = 'sine';

                    // 60Hz Mains hum with hypnotic beating & 3rd harmonic
                    osc1.frequency.value = 60.0;
                    osc2.frequency.value = 60.42;
                    osc3.frequency.value = 180.15;

                    lp.type = 'lowpass';
                    lp.frequency.value = 240 + state.params.timbre * 300;

                    gain.gain.setValueAtTime(0.001, now);
                    gain.gain.exponentialRampToValueAtTime(0.11, now + 0.4);

                    osc1.connect(lp);
                    osc2.connect(lp);
                    osc3.connect(lp);
                    lp.connect(gain);
                    gain.connect(this.voiceBus);

                    osc1.start(now);
                    osc2.start(now);
                    osc3.start(now);

                    this.humDrone = { osc1, osc2, osc3, lp, gain };
                }
                return state.humRunning;
            }

            toggleDefrostHiss(forceState) {
                if (!this.ctx) return;
                const nextState = forceState !== undefined ? forceState : !state.defrostHissRunning;
                state.defrostHissRunning = nextState;

                const now = this.ctx.currentTime;
                if (!nextState && this.defrostNode) {
                    this.defrostNode.gain.gain.setTargetAtTime(0.0001, now, 0.1);
                    const old = this.defrostNode;
                    setTimeout(() => {
                        try { old.source.disconnect(); } catch (e) {}
                    }, 200);
                    this.defrostNode = null;
                    return false;
                }

                if (nextState && !this.defrostNode) {
                    const gain = this.ctx.createGain();
                    gain.gain.setValueAtTime(0.001, now);
                    gain.gain.exponentialRampToValueAtTime(0.24, now + 0.2);

                    let source;
                    if (this.workletReady) {
                        source = new AudioWorkletNode(this.ctx, 'cryo-texture-processor');
                        source.parameters.get('density').value = 0.5 + state.params.timbre * 0.4;
                        source.parameters.get('crackle').value = 0.65;
                        source.parameters.get('frostTone').value = state.thermostat / 100;
                    } else {
                        // Fallback filtered noise buffer
                        const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
                        const data = buf.getChannelData(0);
                        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
                        source = this.ctx.createBufferSource();
                        source.buffer = buf;
                        source.loop = true;
                        source.start(now);
                    }

                    source.connect(gain);
                    gain.connect(this.voiceBus);
                    this.defrostNode = { source, gain };
                }
                return state.defrostHissRunning;
            }

            // =========================================================================
            // 4. UNIVERSAL VOICE SYNTHESIZER (WORKS REAL-TIME & OFFLINE WAV RENDER)
            // =========================================================================
            triggerInstrumentVoice({
                ctx = this.ctx,
                destination = this.voiceBus,
                instrument = state.activeInstrument,
                freq = 220,
                time = null,
                velocity = 0.85,
                params = state.params,
                thermostat = state.thermostat,
                rng = state.rng
            } = {}) {
                if (!ctx || !destination) return;
                const now = time !== null ? time : ctx.currentTime;
                const cold = thermostat / 100; // 0 = warm analog, 1 = brittle cryo
                const panNode = ctx.createStereoPanner();
                panNode.pan.value = (rng.next() * 2 - 1) * params.stereo * 0.8;
                panNode.connect(destination);

                // Pitch adjustment from knob + temperature drift
                const pitchMultiplier = Math.pow(2, (params.pitch - 0.5) * 1.5);
                const drift = (1 - cold) * (rng.next() - 0.5) * 0.025;
                const baseFreq = freq * pitchMultiplier * (1 + drift);
                const decayTime = 0.15 + params.decay * 2.4;

                switch (instrument) {
                    case 'compressor': {
                        // Deep Industrial FM Subharmonic Voice
                        const car = ctx.createOscillator();
                        const mod = ctx.createOscillator();
                        const sub = ctx.createOscillator();
                        const modGain = ctx.createGain();
                        const filt = ctx.createBiquadFilter();
                        const env = ctx.createGain();

                        car.type = 'sawtooth';
                        car.frequency.setValueAtTime(baseFreq * 0.5, now);
                        // Mechanical pitch sag
                        car.frequency.exponentialRampToValueAtTime(baseFreq * 0.48, now + decayTime);

                        sub.type = 'square';
                        sub.frequency.setValueAtTime(baseFreq * 0.25, now);

                        mod.type = 'sine';
                        mod.frequency.setValueAtTime(baseFreq * (1.414 + cold * 1.2), now);
                        modGain.gain.setValueAtTime((80 + params.timbre * 380) * velocity, now);
                        modGain.gain.exponentialRampToValueAtTime(8, now + decayTime * 0.85);

                        filt.type = 'lowpass';
                        filt.frequency.setValueAtTime(220 + params.timbre * 1800, now);
                        filt.Q.value = 2.0 + params.resonance * 10;

                        env.gain.setValueAtTime(0.001, now);
                        env.gain.linearRampToValueAtTime(0.38 * velocity, now + 0.02);
                        env.gain.exponentialRampToValueAtTime(0.0001, now + decayTime);

                        mod.connect(modGain);
                        modGain.connect(car.frequency);
                        car.connect(filt);
                        sub.connect(filt);
                        filt.connect(env);
                        env.connect(panNode);

                        car.start(now);
                        mod.start(now);
                        sub.start(now);
                        car.stop(now + decayTime + 0.05);
                        mod.stop(now + decayTime + 0.05);
                        sub.stop(now + decayTime + 0.05);
                        break;
                    }

                    case 'freezer': {
                        // Crystalline Granular Shimmer Cloud & Inharmonic FM Bell
                        const grainCount = 4 + Math.floor(cold * 5);
                        const ratios = [1.0, 2.756, 4.14, 5.404, 6.72];
                        for (let g = 0; g < grainCount; g++) {
                            const gOffset = g * (0.02 + rng.next() * 0.045);
                            const t0 = now + gOffset;
                            const gDur = 0.12 + params.decay * 0.9;
                            const ratio = ratios[g % ratios.length] * (1 + cold * 0.25);

                            const car = ctx.createOscillator();
                            const mod = ctx.createOscillator();
                            const modG = ctx.createGain();
                            const gEnv = ctx.createGain();

                            car.type = 'sine';
                            car.frequency.setValueAtTime(baseFreq * ratio, t0);

                            mod.type = 'sine';
                            mod.frequency.setValueAtTime(baseFreq * ratio * 3.1415, t0);
                            modG.gain.setValueAtTime(baseFreq * (0.5 + params.timbre * 3.5), t0);
                            modG.gain.exponentialRampToValueAtTime(0.1, t0 + gDur);

                            gEnv.gain.setValueAtTime(0.0001, t0);
                            gEnv.gain.linearRampToValueAtTime((0.18 / Math.sqrt(grainCount)) * velocity, t0 + 0.006);
                            gEnv.gain.exponentialRampToValueAtTime(0.0001, t0 + gDur);

                            mod.connect(modG);
                            modG.connect(car.frequency);
                            car.connect(gEnv);
                            gEnv.connect(panNode);

                            car.start(t0);
                            mod.start(t0);
                            car.stop(t0 + gDur + 0.02);
                            mod.stop(t0 + gDur + 0.02);
                        }
                        break;
                    }

                    case 'icemaker': {
                        // Brittle IDM Ice Impact + Metallic Micro-Glitch
                        const impactDur = 0.06 + params.decay * 0.35;
                        const osc = ctx.createOscillator();
                        const mod = ctx.createOscillator();
                        const modG = ctx.createGain();
                        const bp = ctx.createBiquadFilter();
                        const env = ctx.createGain();

                        osc.type = 'triangle';
                        osc.frequency.setValueAtTime(baseFreq * 2.4, now);
                        osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.65, now + impactDur * 0.4);

                        mod.type = 'square';
                        mod.frequency.setValueAtTime(baseFreq * 5.83, now);
                        modG.gain.setValueAtTime(450 + params.timbre * 1600, now);
                        modG.gain.exponentialRampToValueAtTime(1, now + impactDur);

                        bp.type = 'bandpass';
                        bp.frequency.setValueAtTime(1200 + cold * 3200, now);
                        bp.Q.value = 3.0 + params.resonance * 12;

                        env.gain.setValueAtTime(0.001, now);
                        env.gain.linearRampToValueAtTime(0.45 * velocity, now + 0.002);
                        env.gain.exponentialRampToValueAtTime(0.0001, now + impactDur);

                        mod.connect(modG);
                        modG.connect(osc.frequency);
                        osc.connect(bp);
                        bp.connect(env);
                        env.connect(panNode);

                        osc.start(now);
                        mod.start(now);
                        osc.stop(now + impactDur + 0.02);
                        mod.stop(now + impactDur + 0.02);
                        break;
                    }

                    case 'hum': {
                        // Warm Beating Harmonics & Analog Drift Pad
                        const partials = [1, 1.003, 2.0, 2.996, 4.01];
                        const padDur = 0.4 + params.decay * 2.8;
                        partials.forEach((p, idx) => {
                            const osc = ctx.createOscillator();
                            const pGain = ctx.createGain();
                            osc.type = idx % 2 === 0 ? 'sine' : 'triangle';
                            osc.frequency.setValueAtTime(baseFreq * 0.5 * p, now);

                            const amp = (0.22 / (idx + 1)) * velocity;
                            pGain.gain.setValueAtTime(0.0001, now);
                            pGain.gain.linearRampToValueAtTime(amp, now + 0.05 + idx * 0.02);
                            pGain.gain.exponentialRampToValueAtTime(0.0001, now + padDur);

                            osc.connect(pGain);
                            pGain.connect(panNode);
                            osc.start(now);
                            osc.stop(now + padDur + 0.04);
                        });
                        break;
                    }

                    case 'bottles': {
                        // Modal Glass Resonator Bank (4 Inharmonic Modes per Bottle Strike)
                        const modes = [1.0, 2.32, 4.18, 6.45];
                        const bottleDur = 0.25 + params.decay * 2.2 + params.resonance * 1.2;
                        modes.forEach((m, i) => {
                            const osc = ctx.createOscillator();
                            const mGain = ctx.createGain();
                            osc.type = 'sine';
                            const mFreq = baseFreq * m * (1 + (cold - 0.5) * 0.06);
                            osc.frequency.setValueAtTime(mFreq, now);
                            // Subtle liquid slosh pitch bend
                            osc.frequency.exponentialRampToValueAtTime(mFreq * (1 + (params.modDepth - 0.5) * 0.03), now + bottleDur * 0.5);

                            const modeAmp = (0.32 / Math.pow(i + 1, 1.35)) * velocity;
                            const modeDecay = bottleDur / (1 + i * 0.65);

                            mGain.gain.setValueAtTime(0.0001, now);
                            mGain.gain.linearRampToValueAtTime(modeAmp, now + 0.003);
                            mGain.gain.exponentialRampToValueAtTime(0.0001, now + modeDecay);

                            osc.connect(mGain);
                            mGain.connect(panNode);
                            osc.start(now);
                            osc.stop(now + modeDecay + 0.03);
                        });
                        break;
                    }

                    case 'defrost': {
                        // Resonant Water Droplet Pluck + Frost Sizzle Burst
                        const dropDur = 0.14 + params.decay * 0.45;
                        const osc = ctx.createOscillator();
                        const env = ctx.createGain();

                        osc.type = 'sine';
                        // Classic water droplet upward frequency chirp
                        osc.frequency.setValueAtTime(baseFreq * 0.65, now);
                        osc.frequency.exponentialRampToValueAtTime(baseFreq * (2.2 + params.timbre * 1.5), now + dropDur * 0.65);

                        env.gain.setValueAtTime(0.001, now);
                        env.gain.linearRampToValueAtTime(0.38 * velocity, now + 0.005);
                        env.gain.exponentialRampToValueAtTime(0.0001, now + dropDur);

                        osc.connect(env);
                        env.connect(panNode);
                        osc.start(now);
                        osc.stop(now + dropDur + 0.02);
                        break;
                    }

                    case 'doorseal': {
                        // Elastic Rubber Bass + High-Q Friction Squeak
                        const rubDur = 0.22 + params.decay * 1.1;
                        const osc = ctx.createOscillator();
                        const squeakOsc = ctx.createOscillator();
                        const filt = ctx.createBiquadFilter();
                        const env = ctx.createGain();

                        osc.type = 'sawtooth';
                        // Elastic pitch bounce
                        osc.frequency.setValueAtTime(baseFreq * 0.5, now);
                        osc.frequency.exponentialRampToValueAtTime(baseFreq * (1.2 + params.modDepth * 1.5), now + 0.07);
                        osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.35, now + rubDur);

                        squeakOsc.type = 'triangle';
                        squeakOsc.frequency.setValueAtTime(baseFreq * 3.5, now);
                        squeakOsc.frequency.linearRampToValueAtTime(baseFreq * 1.8, now + rubDur * 0.4);

                        filt.type = 'bandpass';
                        filt.frequency.setValueAtTime(300 + params.timbre * 2200, now);
                        filt.frequency.exponentialRampToValueAtTime(140, now + rubDur);
                        filt.Q.value = 5.0 + params.resonance * 14;

                        env.gain.setValueAtTime(0.001, now);
                        env.gain.linearRampToValueAtTime(0.45 * velocity, now + 0.012);
                        env.gain.exponentialRampToValueAtTime(0.0001, now + rubDur);

                        osc.connect(filt);
                        squeakOsc.connect(filt);
                        filt.connect(env);
                        env.connect(panNode);

                        osc.start(now);
                        squeakOsc.start(now);
                        osc.stop(now + rubDur + 0.03);
                        squeakOsc.stop(now + rubDur + 0.03);
                        break;
                    }

                    case 'light':
                    default: {
                        // Luminous Additive Harmonic Chime
                        const chimeDur = 0.35 + params.decay * 2.5;
                        const harmonics = [1, 2, 3, 4.2, 5.8, 7.6, 9.2];
                        harmonics.forEach((h, idx) => {
                            const osc = ctx.createOscillator();
                            const hGain = ctx.createGain();
                            osc.type = 'sine';
                            osc.frequency.setValueAtTime(baseFreq * h * (1 + cold * 0.15), now);

                            const amp = (0.24 / (idx + 1)) * velocity * (idx > 2 ? params.timbre : 1);
                            const hDecay = chimeDur / (1 + idx * 0.35);

                            hGain.gain.setValueAtTime(0.0001, now);
                            hGain.gain.linearRampToValueAtTime(amp, now + 0.004 + idx * 0.006);
                            hGain.gain.exponentialRampToValueAtTime(0.0001, now + hDecay);

                            osc.connect(hGain);
                            hGain.connect(panNode);
                            osc.start(now);
                            osc.stop(now + hDecay + 0.03);
                        });
                        break;
                    }
                }
            }

            // =========================================================================
            // 5. PLAYFUL MACRO INTERACTIONS (FREEZE, DEFROST, HAUNTED, STRANGE, SHAKE)
            // =========================================================================
            toggleFreezeSound() {
                if (!this.ctx) return;
                state.frozenBufferActive = !state.frozenBufferActive;
                const now = this.ctx.currentTime;

                if (state.frozenBufferActive) {
                    // Lock ping-pong delay into infinite crystalline shimmer hold
                    this.delayFeedbackNode.gain.setTargetAtTime(0.96, now, 0.05);
                    this.reverbWetGain.gain.setTargetAtTime(0.88, now, 0.05);
                    // Trigger an icy chord burst into the frozen buffer
                    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
                        this.triggerInstrumentVoice({
                            instrument: 'freezer',
                            freq: f,
                            time: now + i * 0.03,
                            velocity: 0.65
                        });
                    });
                } else {
                    this.delayFeedbackNode.gain.setTargetAtTime(state.fx.delayFeedback, now, 0.1);
                    this.reverbWetGain.gain.setTargetAtTime(state.fx.reverbMix, now, 0.1);
                }
                return state.frozenBufferActive;
            }

            triggerDefrostMelt() {
                if (!this.ctx) return;
                const now = this.ctx.currentTime;
                // Downward glissando across active drones and 6 melting droplets
                if (this.compressorDrone) {
                    const c = this.compressorDrone.carrier.frequency;
                    c.cancelScheduledValues(now);
                    c.setValueAtTime(c.value * 1.6, now);
                    c.exponentialRampToValueAtTime(24, now + 2.2);
                }
                for (let i = 0; i < 8; i++) {
                    const t = now + i * 0.12;
                    this.triggerInstrumentVoice({
                        instrument: 'defrost',
                        freq: 600 - i * 55,
                        time: t,
                        velocity: 0.8
                    });
                }
            }

            triggerHauntedFridge() {
                if (!this.ctx) return;
                state.hauntedMode = !state.hauntedMode;
                const now = this.ctx.currentTime;
                // Eerie microtonal cluster + ghostly door seal creaks
                const eerieFreqs = [110, 116.5, 233.08, 311.13, 452.8, 622.25];
                eerieFreqs.forEach((f, idx) => {
                    this.triggerInstrumentVoice({
                        instrument: idx % 2 === 0 ? 'bottles' : 'doorseal',
                        freq: f,
                        time: now + idx * 0.14,
                        velocity: 0.75
                    });
                });
            }

            triggerShakeCrash() {
                if (!this.ctx) return;
                const now = this.ctx.currentTime;
                // Mechanical coil spring crash + rattling glass bottles + falling ice cubes
                for (let i = 0; i < 6; i++) {
                    const bFreq = 240 + (1 - state.bottleLevels[i]) * 680;
                    this.triggerInstrumentVoice({
                        instrument: 'bottles',
                        freq: bFreq,
                        time: now + i * 0.035,
                        velocity: 0.9
                    });
                }
                for (let j = 0; j < 5; j++) {
                    this.triggerInstrumentVoice({
                        instrument: 'icemaker',
                        freq: 350 + j * 190,
                        time: now + 0.05 + j * 0.045,
                        velocity: 0.95
                    });
                }
                this.triggerInstrumentVoice({
                    instrument: 'compressor',
                    freq: 55,
                    time: now,
                    velocity: 1.0
                });
            }

            silenceAll() {
                this.toggleCompressorDrone(false);
                this.toggleHumDrone(false);
                this.toggleDefrostHiss(false);
                state.frozenBufferActive = false;
                if (this.delayFeedbackNode && this.ctx) {
                    this.delayFeedbackNode.gain.setValueAtTime(0, this.ctx.currentTime);
                    setTimeout(() => {
                        if (this.delayFeedbackNode) {
                            this.delayFeedbackNode.gain.value = state.fx.delayFeedback;
                        }
                    }, 150);
                }
            }
        }

        // =========================================================================
        // 6. AUDIOPHILE OFFLINE WAV RENDERER (16-BIT, TRUE 24-BIT PCM, 32-BIT FLOAT)
        // =========================================================================
        class WavStudioExporter {
            static async renderOfflinePatch({
                sampleRate = 48000,
                bitDepth = 24,
                duration = 4.5,
                normalize = true,
                seed = state.seed,
                instrument = state.activeInstrument,
                params = { ...state.params },
                thermostat = state.thermostat
            } = {}) {
                const totalFrames = Math.floor(sampleRate * duration);
                const offlineCtx = new OfflineAudioContext(2, totalFrames, sampleRate);
                const rng = new SeededRandom(seed);

                // Master Offline Graph
                const masterBus = offlineCtx.createGain();
                masterBus.gain.value = 0.85;

                // Stereo Delay + Cryo Reverb in Offline Context
                const delayL = offlineCtx.createDelay(2.0);
                const delayR = offlineCtx.createDelay(2.0);
                delayL.delayTime.value = state.fx.delayTime;
                delayR.delayTime.value = state.fx.delayTime * 1.33;

                const fb = offlineCtx.createGain();
                fb.gain.value = state.fx.delayFeedback;

                const merger = offlineCtx.createChannelMerger(2);
                const delayWet = offlineCtx.createGain();
                delayWet.gain.value = 0.32;

                masterBus.connect(delayL);
                delayL.connect(delayR);
                delayR.connect(fb);
                fb.connect(delayL);
                delayL.connect(merger, 0, 0);
                delayR.connect(merger, 0, 1);
                merger.connect(delayWet);

                // Reverb Convolver
                const conv = offlineCtx.createConvolver();
                conv.buffer = synth.generateCryoImpulse(offlineCtx, 2.6, 2.4);
                const revWet = offlineCtx.createGain();
                revWet.gain.value = state.fx.reverbMix;
                masterBus.connect(conv);
                conv.connect(revWet);

                // Door Lowpass Filter
                const doorLP = offlineCtx.createBiquadFilter();
                doorLP.type = 'lowpass';
                doorLP.frequency.value = state.doorOpen ? 18500 : 420;

                masterBus.connect(doorLP);
                delayWet.connect(doorLP);
                revWet.connect(doorLP);
                doorLP.connect(offlineCtx.destination);

                // Schedule rich evolving gesture during offline render
                const scale = [130.81, 164.81, 196.00, 246.94, 261.63, 329.63, 392.00, 523.25];
                const eventCount = duration > 5 ? 12 : 6;
                for (let i = 0; i < eventCount; i++) {
                    const t = i * ((duration * 0.62) / eventCount);
                    const noteFreq = rng.choice(scale) * (instrument === 'freezer' || instrument === 'light' ? 2 : 1);
                    synth.triggerInstrumentVoice({
                        ctx: offlineCtx,
                        destination: masterBus,
                        instrument,
                        freq: noteFreq,
                        time: t,
                        velocity: 0.75 + rng.next() * 0.25,
                        params,
                        thermostat,
                        rng
                    });
                }

                // Also layer subtle continuous compressor/hum bed if duration >= 4s
                if (duration >= 4.0) {
                    synth.triggerInstrumentVoice({
                        ctx: offlineCtx,
                        destination: masterBus,
                        instrument: 'compressor',
                        freq: 55,
                        time: 0.02,
                        velocity: 0.55,
                        params,
                        thermostat,
                        rng
                    });
                }

                const renderedBuffer = await offlineCtx.startRendering();
                return WavStudioExporter.encodeWAV(renderedBuffer, bitDepth, normalize);
            }

            static encodeWAV(audioBuffer, bitDepth = 24, normalize = true) {
                const numChannels = audioBuffer.numberOfChannels;
                const sampleRate = audioBuffer.sampleRate;
                const numFrames = audioBuffer.length;

                const chL = audioBuffer.getChannelData(0);
                const chR = numChannels > 1 ? audioBuffer.getChannelData(1) : chL;

                // Optional Peak Normalization (-0.3 dBFS -> 0.966)
                let gain = 1.0;
                if (normalize) {
                    let peak = 0;
                    for (let i = 0; i < numFrames; i++) {
                        const absL = Math.abs(chL[i]);
                        const absR = Math.abs(chR[i]);
                        if (absL > peak) peak = absL;
                        if (absR > peak) peak = absR;
                    }
                    if (peak > 0.0001) {
                        gain = 0.966 / peak;
                    }
                }

                const bytesPerSample = bitDepth / 8;
                const blockAlign = numChannels * bytesPerSample;
                const byteRate = sampleRate * blockAlign;
                const dataSize = numFrames * blockAlign;
                const buffer = new ArrayBuffer(44 + dataSize);
                const view = new DataView(buffer);

                const writeStr = (offset, str) => {
                    for (let i = 0; i < str.length; i++) {
                        view.setUint8(offset + i, str.charCodeAt(i));
                    }
                };

                // RIFF WAVE Header
                writeStr(0, 'RIFF');
                view.setUint32(4, 36 + dataSize, true);
                writeStr(8, 'WAVE');
                writeStr(12, 'fmt ');
                view.setUint32(16, 16, true); // PCM chunk size
                view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // 1 = PCM, 3 = IEEE Float
                view.setUint16(22, numChannels, true);
                view.setUint32(24, sampleRate, true);
                view.setUint32(28, byteRate, true);
                view.setUint16(32, blockAlign, true);
                view.setUint16(34, bitDepth, true);
                writeStr(36, 'data');
                view.setUint32(40, dataSize, true);

                let offset = 44;
                const clamp = (v) => Math.max(-1, Math.min(1, v));

                for (let i = 0; i < numFrames; i++) {
                    const samples = [clamp(chL[i] * gain), clamp(chR[i] * gain)];
                    for (let c = 0; c < numChannels; c++) {
                        const s = samples[c];
                        if (bitDepth === 16) {
                            const int16 = s < 0 ? s * 0x8000 : s * 0x7FFF;
                            view.setInt16(offset, Math.round(int16), true);
                            offset += 2;
                        } else if (bitDepth === 24) {
                            // Genuine signed 24-bit little-endian sample packing
                            let int24 = Math.round(s < 0 ? s * 8388608 : s * 8388607);
                            int24 = Math.max(-8388608, Math.min(8388607, int24));
                            if (int24 < 0) int24 += 16777216; // Two's complement unsigned representation
                            view.setUint8(offset, int24 & 0xFF);
                            view.setUint8(offset + 1, (int24 >> 8) & 0xFF);
                            view.setUint8(offset + 2, (int24 >> 16) & 0xFF);
                            offset += 3;
                        } else if (bitDepth === 32) {
                            view.setFloat32(offset, s, true);
                            offset += 4;
                        }
                    }
                }
                return new Blob([buffer], { type: 'audio/wav' });
            }
        }

        // Instantiate Synth Engine
        const synth = new FridgeSynthEngine();

        // =========================================================================
        // 7. INTERACTIVE UI BUILDERS (ICE TRAY, GLASS BOTTLES, KNOBS, KEYBOARD, SEQ)
        // =========================================================================
        function buildIceCubeTray() {
            const tray = document.getElementById('iceCubeTray');
            tray.innerHTML = '';
            const baseNotes = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.5];

            state.iceCubeRatios.forEach((ratio, idx) => {
                const btn = document.createElement('button');
                btn.className = 'ice-cube h-11 rounded-xl flex flex-col items-center justify-center cursor-pointer relative group';
                btn.innerHTML = `
                    <span class="font-mono-tech text-[10px] font-extrabold text-slate-900 group-hover:scale-110 transition">ICE ${idx + 1}</span>
                    <span class="font-mono-tech text-[8px] text-slate-800/80">${ratio.toFixed(2)}x</span>
                `;
                btn.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                    ensureAudioReady();
                    selectInstrument('icemaker');
                    const freq = baseNotes[idx] * (0.85 + (state.thermostat / 100) * 0.4);
                    synth.triggerInstrumentVoice({
                        instrument: idx % 2 === 0 ? 'icemaker' : 'freezer',
                        freq,
                        velocity: 0.92
                    });
                    setStatus(`CRACKED ICE CUBE #${idx + 1} // ${freq.toFixed(1)} Hz Crystalline Modal Impact`);
                });
                tray.appendChild(btn);
            });
        }

        function buildBottleRack() {
            const rack = document.getElementById('bottleRack');
            rack.innerHTML = '';
            const bottleNames = ['MILK', 'TONIC', 'SODA', 'SERUM', 'BRINE', 'FREON'];
            const bottleColors = [
                'from-cyan-200/80 to-emerald-300/80',
                'from-emerald-300/80 to-teal-500/80',
                'from-cyan-400/80 to-blue-500/80',
                'from-amber-300/80 to-orange-400/80',
                'from-teal-300/80 to-cyan-500/80',
                'from-purple-300/80 to-cyan-400/80'
            ];

            state.bottleLevels.forEach((level, idx) => {
                const wrap = document.createElement('div');
                wrap.className = 'glass-bottle flex flex-col items-center h-full justify-end select-none';
                const freq = Math.round(220 + (1 - level) * 720);

                wrap.innerHTML = `
                    <div class="w-4 h-2.5 rounded-t bg-slate-200/80 border border-white/60"></div>
                    <div class="w-3 h-3 bg-cyan-200/25 border-x border-white/40"></div>
                    <div class="w-full h-24 rounded-t-xl rounded-b-lg bg-cyan-100/10 border-2 border-cyan-200/50 relative overflow-hidden flex flex-col justify-end shadow-inner">
                        <div id="bottleFill-${idx}" class="w-full bg-gradient-to-t ${bottleColors[idx]} transition-all duration-75" style="height: ${Math.round(level * 100)}%"></div>
                        <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                            <span class="font-mono-tech text-[9px] font-bold text-white drop-shadow">${bottleNames[idx]}</span>
                            <span id="bottleHz-${idx}" class="font-mono-tech text-[8px] text-cyan-100 drop-shadow">${freq}Hz</span>
                        </div>
                    </div>
                `;

                let dragging = false;
                let startY = 0;
                let startLevel = level;

                wrap.addEventListener('pointerdown', (e) => {
                    e.stopPropagation();
                    ensureAudioReady();
                    selectInstrument('bottles');
                    dragging = true;
                    startY = e.clientY;
                    startLevel = state.bottleLevels[idx];
                    wrap.setPointerCapture(e.pointerId);

                    const curFreq = 220 + (1 - state.bottleLevels[idx]) * 720;
                    synth.triggerInstrumentVoice({
                        instrument: 'bottles',
                        freq: curFreq,
                        velocity: 0.9
                    });
                    setStatus(`BOTTLE #${idx + 1} (${bottleNames[idx]}) // ${Math.round(curFreq)} Hz — Drag vertically to tune liquid`);
                });

                wrap.addEventListener('pointermove', (e) => {
                    if (!dragging) return;
                    const dy = startY - e.clientY;
                    const newLevel = Math.max(0.08, Math.min(0.95, startLevel + dy / 110));
                    state.bottleLevels[idx] = newLevel;
                    const fillEl = document.getElementById(`bottleFill-${idx}`);
                    const hzEl = document.getElementById(`bottleHz-${idx}`);
                    const newFreq = Math.round(220 + (1 - newLevel) * 720);
                    if (fillEl) fillEl.style.height = `${Math.round(newLevel * 100)}%`;
                    if (hzEl) hzEl.textContent = `${newFreq}Hz`;
                });

                wrap.addEventListener('pointerup', (e) => {
                    if (!dragging) return;
                    dragging = false;
                    const finalFreq = 220 + (1 - state.bottleLevels[idx]) * 720;
                    synth.triggerInstrumentVoice({
                        instrument: 'bottles',
                        freq: finalFreq,
                        velocity: 0.75
                    });
                });

                rack.appendChild(wrap);
            });
        }

        function buildRotaryKnobs() {
            const defs = [
                { key: 'pitch', label: 'PITCH TUNE', unit: '%' },
                { key: 'timbre', label: 'FM TIMBRE', unit: '%' },
                { key: 'modDepth', label: 'DRIFT MOD', unit: '%' },
                { key: 'resonance', label: 'RESONANCE', unit: '%' },
                { key: 'decay', label: 'DECAY TAIL', unit: '%' },
                { key: 'drive', label: 'WARM DRIVE', unit: '%' },
                { key: 'stereo', label: 'STEREO PAN', unit: '%' },
                { key: 'cryoMix', label: 'CRYO SHIMMER', unit: '%' }
            ];
            const container = document.getElementById('knobRack');
            container.innerHTML = '';

            defs.forEach(def => {
                const val = state.params[def.key];
                const deg = -135 + val * 270;
                const wrap = document.createElement('div');
                wrap.className = 'knob-wrapper select-none';
                wrap.innerHTML = `
                    <div class="knob-dial" id="knobDial-${def.key}">
                        <div class="knob-indicator" id="knobInd-${def.key}" style="transform: rotate(${deg}deg)"></div>
                    </div>
                    <span class="font-mono-tech text-[10px] text-emerald-200 mt-1.5 font-semibold">${def.label}</span>
                    <span id="knobVal-${def.key}" class="font-mono-tech text-[10px] text-cyan-300">${Math.round(val * 100)}${def.unit}</span>
                `;

                let dragging = false;
                let startY = 0;
                let startVal = val;

                wrap.addEventListener('pointerdown', (e) => {
                    ensureAudioReady();
                    dragging = true;
                    startY = e.clientY;
                    startVal = state.params[def.key];
                    wrap.setPointerCapture(e.pointerId);
                });

                wrap.addEventListener('pointermove', (e) => {
                    if (!dragging) return;
                    const dy = startY - e.clientY;
                    const nextVal = Math.max(0.0, Math.min(1.0, startVal + dy / 130));
                    setKnobValue(def.key, nextVal);
                });

                wrap.addEventListener('pointerup', () => {
                    dragging = false;
                });

                container.appendChild(wrap);
            });
        }

        function setKnobValue(key, val) {
            state.params[key] = val;
            const deg = -135 + val * 270;
            const ind = document.getElementById(`knobInd-${key}`);
            const txt = document.getElementById(`knobVal-${key}`);
            if (ind) ind.style.transform = `rotate(${deg}deg)`;
            if (txt) txt.textContent = `${Math.round(val * 100)}%`;

            if (key === 'drive') synth.updateDriveCurve(val);
            if (key === 'timbre' || key === 'resonance') synth.updateThermostatDSP();
            updateScopeReadout();
        }

        function buildPianoKeyboard() {
            const kb = document.getElementById('pianoKeyboard');
            kb.innerHTML = '';
            const notes = [
                { note: 'C', semi: 0, key: 'A', black: false },
                { note: 'C#', semi: 1, key: 'W', black: true },
                { note: 'D', semi: 2, key: 'S', black: false },
                { note: 'D#', semi: 3, key: 'E', black: true },
                { note: 'E', semi: 4, key: 'D', black: false },
                { note: 'F', semi: 5, key: 'F', black: false },
                { note: 'F#', semi: 6, key: 'T', black: true },
                { note: 'G', semi: 7, key: 'G', black: false },
                { note: 'G#', semi: 8, key: 'Y', black: true },
                { note: 'A', semi: 9, key: 'H', black: false },
                { note: 'A#', semi: 10, key: 'U', black: true },
                { note: 'B', semi: 11, key: 'J', black: false },
                { note: 'C+', semi: 12, key: 'K', black: false }
            ];

            notes.forEach(n => {
                const btn = document.createElement('button');
                btn.dataset.semi = n.semi;
                btn.dataset.kbd = n.key;
                btn.className = `synth-key flex-1 rounded-lg flex flex-col justify-between items-center p-1.5 font-mono-tech cursor-pointer border ${
                    n.black
                        ? 'bg-slate-950 text-cyan-300 border-cyan-500/40 h-16 -mx-1 z-10 shadow-lg'
                        : 'bg-emerald-100/90 text-slate-900 border-emerald-400 h-full'
                }`;
                btn.innerHTML = `
                    <span class="text-[9px] opacity-70">${n.key}</span>
                    <span class="text-[10px] font-bold">${n.note}</span>
                `;

                btn.addEventListener('pointerdown', () => {
                    triggerSemitone(n.semi, btn);
                });
                kb.appendChild(btn);
            });
        }

        function triggerSemitone(semitoneOffset, btnEl = null) {
            ensureAudioReady();
            const midi = (state.octave + 1) * 12 + semitoneOffset;
            const freq = 440 * Math.pow(2, (midi - 69) / 12);
            synth.triggerInstrumentVoice({
                instrument: state.activeInstrument,
                freq,
                velocity: 0.9
            });
            if (btnEl) {
                btnEl.classList.add('key-active');
                setTimeout(() => btnEl.classList.remove('key-active'), 160);
            }
        }

        function buildSequencerGrid() {
            const grid = document.getElementById('sequencerGrid');
            grid.innerHTML = '';
            state.seqSteps.forEach((active, idx) => {
                const btn = document.createElement('button');
                btn.id = `seqStep-${idx}`;
                btn.className = `h-8 rounded-lg font-mono-tech text-[10px] font-bold transition border cursor-pointer ${
                    active
                        ? 'bg-cyan-500/30 text-cyan-200 border-cyan-400'
                        : 'bg-slate-900/80 text-emerald-500/50 border-emerald-500/20'
                }`;
                btn.textContent = idx + 1;
                btn.addEventListener('click', () => {
                    state.seqSteps[idx] = state.seqSteps[idx] ? 0 : 1;
                    buildSequencerGrid();
                });
                grid.appendChild(btn);
            });
        }

        // =========================================================================
        // 8. GENERATIVE SEQUENCER CLOCK LOOP
        // =========================================================================
        let seqInterval = null;
        function startSequencerLoop() {
            if (seqInterval) clearInterval(seqInterval);
            const stepMs = (60 / state.bpm / 4) * 1000;
            seqInterval = setInterval(() => {
                if (!state.seqPlaying && !state.iceMakerAuto) return;
                ensureAudioReady();

                const step = state.currentStep;
                // Highlight current step
                for (let i = 0; i < 16; i++) {
                    const el = document.getElementById(`seqStep-${i}`);
                    if (el) {
                        el.classList.toggle('ring-2', i === step);
                        el.classList.toggle('ring-white', i === step);
                    }
                }

                const activeStep = state.seqSteps[step];
                const prob = (state.density / 100);
                if (activeStep && state.rng.next() <= prob) {
                    const instPool = state.iceMakerAuto
                        ? ['icemaker', 'freezer', 'bottles', 'defrost']
                        : [state.activeInstrument, 'icemaker', 'bottles'];
                    const chosenInst = state.rng.choice(instPool);
                    const scaleSemis = [0, 3, 5, 7, 10, 12, 15, 19];
                    const semi = state.rng.choice(scaleSemis);
                    const midi = (state.octave + 1) * 12 + semi;
                    const freq = 440 * Math.pow(2, (midi - 69) / 12);

                    synth.triggerInstrumentVoice({
                        instrument: chosenInst,
                        freq,
                        velocity: 0.65 + state.rng.next() * 0.35
                    });
                }

                state.currentStep = (state.currentStep + 1) % 16;
            }, stepMs);
        }

        // =========================================================================
        // 9. REAL-TIME WAVEFORM + FFT SPECTRUM + FROST PARTICLE VISUALIZERS
        // =========================================================================
        function startVisualizers() {
            const scopeCanvas = document.getElementById('scopeCanvas');
            const sCtx = scopeCanvas.getContext('2d');
            const frostCanvas = document.getElementById('frostCanvas');
            const fCtx = frostCanvas.getContext('2d');

            const particles = Array.from({ length: 34 }, () => ({
                x: Math.random() * 400,
                y: Math.random() * 140,
                r: 1 + Math.random() * 2.5,
                vx: (Math.random() - 0.5) * 0.4,
                vy: 0.2 + Math.random() * 0.6
            }));

            function renderFrame() {
                requestAnimationFrame(renderFrame);

                // 1. Render Scope & FFT
                const w = scopeCanvas.width = scopeCanvas.clientWidth * window.devicePixelRatio;
                const h = scopeCanvas.height = scopeCanvas.clientHeight * window.devicePixelRatio;
                sCtx.fillStyle = '#050b09';
                sCtx.fillRect(0, 0, w, h);

                // Subtle graticule grid
                sCtx.strokeStyle = 'rgba(44, 110, 82, 0.22)';
                sCtx.lineWidth = 1;
                for (let x = 0; x < w; x += w / 8) {
                    sCtx.beginPath(); sCtx.moveTo(x, 0); sCtx.lineTo(x, h); sCtx.stroke();
                }
                for (let y = 0; y < h; y += h / 4) {
                    sCtx.beginPath(); sCtx.moveTo(0, y); sCtx.lineTo(w, y); sCtx.stroke();
                }

                if (synth.analyser) {
                    const freqLen = synth.analyser.frequencyBinCount;
                    const freqData = new Uint8Array(freqLen);
                    const timeData = new Uint8Array(freqLen);
                    synth.analyser.getByteFrequencyData(freqData);
                    synth.analyser.getByteTimeDomainData(timeData);

                    // Draw FFT Spectrum Bars
                    const barCount = 64;
                    const barW = w / barCount;
                    const coldRatio = state.thermostat / 100;
                    for (let i = 0; i < barCount; i++) {
                        const val = freqData[i * 2] / 255;
                        const barH = val * (h * 0.78);
                        sCtx.fillStyle = coldRatio > 0.5
                            ? `rgba(0, 245, 255, ${0.15 + val * 0.45})`
                            : `rgba(255, 165, 30, ${0.15 + val * 0.45})`;
                        sCtx.fillRect(i * barW, h - barH, barW - 2, barH);
                    }

                    // Draw Oscilloscope Waveform Trace
                    sCtx.beginPath();
                    sCtx.strokeStyle = coldRatio > 0.5 ? '#00f5ff' : '#fbbf24';
                    sCtx.lineWidth = 2.2 * window.devicePixelRatio;
                    const sliceW = w / timeData.length;
                    let x = 0;
                    for (let i = 0; i < timeData.length; i++) {
                        const v = timeData[i] / 128.0;
                        const y = (v * h) / 2;
                        if (i === 0) sCtx.moveTo(x, y);
                        else sCtx.lineTo(x, y);
                        x += sliceW;
                    }
                    sCtx.stroke();
                }

                // 2. Render Freezer Frost Particles
                const fw = frostCanvas.width = frostCanvas.clientWidth;
                const fh = frostCanvas.height = frostCanvas.clientHeight;
                fCtx.clearRect(0, 0, fw, fh);
                const frostDensity = state.thermostat / 100;
                fCtx.fillStyle = `rgba(165, 243, 252, ${0.25 + frostDensity * 0.55})`;

                particles.forEach(p => {
                    p.x += p.vx;
                    p.y += p.vy * (0.4 + frostDensity);
                    if (p.y > fh) { p.y = 0; p.x = Math.random() * fw; }
                    if (p.x < 0) p.x = fw;
                    if (p.x > fw) p.x = 0;
                    fCtx.beginPath();
                    fCtx.arc(p.x, p.y, p.r * (0.6 + frostDensity * 0.7), 0, Math.PI * 2);
                    fCtx.fill();
                });
            }
            requestAnimationFrame(renderFrame);
        }

        // =========================================================================
        // 10. UI EVENT WIRING & CONTROLLER HELPERS
        // =========================================================================
        async function ensureAudioReady() {
            if (!state.powered) {
                await synth.init();
                state.powered = true;
                document.getElementById('bootOverlay').classList.add('opacity-0', 'pointer-events-none');
                const badge = document.getElementById('audioStatusBadge');
                badge.textContent = '48kHz DSP ONLINE';
                badge.classList.replace('text-cyan-300', 'text-emerald-300');
            } else if (synth.ctx && synth.ctx.state === 'suspended') {
                await synth.ctx.resume();
            }
        }

        function setStatus(msg) {
            const el = document.getElementById('statusMessage');
            if (el) el.textContent = msg;
        }

        function updateScopeReadout() {
            const left = document.getElementById('dspReadoutLeft');
            const right = document.getElementById('dspReadoutRight');
            if (left) {
                left.textContent = `TIMBRE: ${Math.round(state.params.timbre * 100)}% | RES: ${Math.round(state.params.resonance * 100)}% | DECAY: ${(0.15 + state.params.decay * 2.4).toFixed(2)}s`;
            }
            if (right) {
                right.textContent = state.doorOpen ? 'DOOR OPEN: 19.0 kHz' : 'DOOR SEALED: 380 Hz LP';
            }
        }

        function selectInstrument(instName) {
            state.activeInstrument = instName;
            document.getElementById('activeInstrumentHeader').textContent = `ACTIVE MODULE: ${instName.toUpperCase()}`;

            document.querySelectorAll('.inst-tab').forEach(btn => {
                const isMatch = btn.dataset.inst === instName;
                btn.classList.toggle('bg-cyan-500/20', isMatch);
                btn.classList.toggle('text-cyan-200', isMatch);
                btn.classList.toggle('border-cyan-400/60', isMatch);
                btn.classList.toggle('bg-emerald-950/60', !isMatch);
                btn.classList.toggle('text-emerald-300', !isMatch);
                btn.classList.toggle('border-emerald-500/20', !isMatch);
            });
        }

        function toggleDoor(forceOpen) {
            ensureAudioReady();
            state.doorOpen = forceOpen !== undefined ? forceOpen : !state.doorOpen;
            const overlay = document.getElementById('closedDoorOverlay');
            const btnLabel = document.getElementById('doorBtnLabel');
            const stateText = document.getElementById('doorStateText');
            const stateDot = document.getElementById('doorStateIndicator');

            overlay.classList.toggle('door-open', state.doorOpen);
            btnLabel.textContent = state.doorOpen ? 'CLOSE DOOR' : 'OPEN DOOR';
            stateText.textContent = state.doorOpen ? 'DOOR OPEN // DIRECT ACOUSTICS' : 'DOOR CLOSED // MUFFLED CAVITY';
            stateDot.className = `w-2.5 h-2.5 rounded-full border border-white/50 ${state.doorOpen ? 'bg-cyan-400 shadow-[0_0_8px_#00f5ff]' : 'bg-amber-500'}`;

            synth.updateDoorFilter(state.doorOpen);
            // Trigger realistic rubber door gasket suction sound on open/close
            synth.triggerInstrumentVoice({
                instrument: 'doorseal',
                freq: state.doorOpen ? 135 : 92,
                velocity: 0.75
            });
            updateScopeReadout();
        }

        // Expose helper globally for inline door handle button
        window.fridgeApp = { toggleDoor };

        function initEventListeners() {
            // Boot Power Button
            document.getElementById('powerOnBtn').addEventListener('click', async () => {
                await ensureAudioReady();
                synth.triggerInstrumentVoice({ instrument: 'light', freq: 523.25, velocity: 0.8 });
            });

            // Door Toggle Buttons
            document.getElementById('toggleDoorBtn').addEventListener('click', () => toggleDoor());
            document.getElementById('exteriorHandleBtn').addEventListener('click', () => toggleDoor(true));

            // Master Thermostat Slider
            document.getElementById('thermostatSlider').addEventListener('input', (e) => {
                ensureAudioReady();
                state.thermostat = Number(e.target.value);
                const celsius = (10 - (state.thermostat / 100) * 32).toFixed(1);
                const zoneLabel = state.thermostat > 75 ? 'CRYOGENIC' : state.thermostat > 40 ? 'CHILLED' : 'WARM DRIFT';
                document.getElementById('tempReadout').textContent = `${celsius} °C (${zoneLabel})`;

                // Shift interior fridge light glow from warm amber to cryo cyan
                const cavity = document.getElementById('fridgeCavity');
                if (state.thermostat > 68) {
                    cavity.style.setProperty('--fridge-light-color', 'rgba(0, 245, 255, 0.26)');
                    cavity.style.setProperty('--fridge-glow', 'rgba(0, 245, 255, 0.25)');
                } else {
                    cavity.style.setProperty('--fridge-light-color', 'rgba(255, 214, 138, 0.28)');
                    cavity.style.setProperty('--fridge-glow', 'rgba(255, 185, 60, 0.2)');
                }
                synth.updateThermostatDSP();
            });

            // Seeded PRNG Sync
            document.getElementById('applySeedBtn').addEventListener('click', () => {
                ensureAudioReady();
                const seedVal = document.getElementById('seedInput').value.trim() || 'CRYO-1958';
                state.seed = seedVal;
                state.rng.setSeed(seedVal);
                // Re-seed all 8 synth knobs deterministically
                Object.keys(state.params).forEach(k => {
                    setKnobValue(k, Number(state.rng.range(0.15, 0.90).toFixed(2)));
                });
                synth.triggerInstrumentVoice({ instrument: state.activeInstrument, freq: 261.63, velocity: 0.85 });
                setStatus(`SEED "${seedVal}" APPLIED // Reproducible synthesis parameters locked`);
            });

            // Master Volume & Silence Panic
            document.getElementById('masterGainSlider').addEventListener('input', (e) => {
                state.masterVolume = Number(e.target.value) / 100;
                if (synth.masterGain && synth.ctx) {
                    synth.masterGain.gain.setTargetAtTime(state.masterVolume, synth.ctx.currentTime, 0.03);
                }
            });
            document.getElementById('panicMuteBtn').addEventListener('click', () => {
                synth.silenceAll();
                updateContinuousButtonsUI();
                setStatus('ALL CONTINUOUS DRONES & BUFFERS SILENCED');
            });

            // 8 Component Selector Tabs
            document.querySelectorAll('.inst-tab').forEach(btn => {
                btn.addEventListener('click', () => {
                    ensureAudioReady();
                    const inst = btn.dataset.inst;
                    selectInstrument(inst);
                    synth.triggerInstrumentVoice({ instrument: inst, freq: 261.63, velocity: 0.85 });
                });
            });

            // Clicking directly on Refrigerator Compartments
            document.querySelectorAll('.instrument-zone').forEach(zone => {
                zone.addEventListener('click', (e) => {
                    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
                    ensureAudioReady();
                    const inst = zone.dataset.instrument;
                    if (inst) {
                        selectInstrument(inst);
                        synth.triggerInstrumentVoice({ instrument: inst, freq: 246.94, velocity: 0.85 });
                        setStatus(`INTERACTED WITH ${inst.toUpperCase()} COMPARTMENT`);
                    }
                });
            });

            // Dedicated Compartment Buttons
            document.getElementById('shimmerBellBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                ensureAudioReady();
                selectInstrument('freezer');
                [783.99, 1046.5, 1567.98].forEach((f, i) => {
                    synth.triggerInstrumentVoice({ instrument: 'freezer', freq: f, time: synth.ctx.currentTime + i * 0.05, velocity: 0.85 });
                });
            });

            document.getElementById('iceSeqToggleBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                ensureAudioReady();
                state.iceMakerAuto = !state.iceMakerAuto;
                const btn = e.currentTarget;
                btn.textContent = state.iceMakerAuto ? 'IDM AUTO: ON' : 'IDM AUTO: OFF';
                btn.classList.toggle('bg-cyan-400', state.iceMakerAuto);
                btn.classList.toggle('text-slate-950', state.iceMakerAuto);
            });

            document.getElementById('chimeBurstBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                ensureAudioReady();
                selectInstrument('light');
                constbulbEffect();
                [523.25, 659.25, 987.77, 1318.5].forEach((f, idx) => {
                    synth.triggerInstrumentVoice({ instrument: 'light', freq: f, time: synth.ctx.currentTime + idx * 0.06, velocity: 0.8 });
                });
            });

            document.getElementById('humDroneToggleBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                ensureAudioReady();
                synth.toggleHumDrone();
                updateContinuousButtonsUI();
            });

            document.getElementById('strumBottlesBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                ensureAudioReady();
                selectInstrument('bottles');
                state.bottleLevels.forEach((lvl, idx) => {
                    const freq = 220 + (1 - lvl) * 720;
                    synth.triggerInstrumentVoice({
                        instrument: 'bottles',
                        freq,
                        time: synth.ctx.currentTime + idx * 0.07,
                        velocity: 0.85
                    });
                });
            });

            document.getElementById('dripTriggerBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                ensureAudioReady();
                selectInstrument('defrost');
                synth.triggerInstrumentVoice({ instrument: 'defrost', freq: 440 + Math.random() * 400, velocity: 0.9 });
            });

            document.getElementById('defrostNoiseToggleBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                ensureAudioReady();
                synth.toggleDefrostHiss();
                updateContinuousButtonsUI();
            });

            document.getElementById('squeakSealBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                ensureAudioReady();
                selectInstrument('doorseal');
                synth.triggerInstrumentVoice({ instrument: 'doorseal', freq: 110 + Math.random() * 90, velocity: 0.95 });
            });

            document.getElementById('compressorToggleBtn').addEventListener('click', (e) => {
                e.stopPropagation();
                ensureAudioReady();
                synth.toggleCompressorDrone();
                updateContinuousButtonsUI();
            });

            document.getElementById('compressorThrottle').addEventListener('input', (e) => {
                ensureAudioReady();
                synth.setCompressorRPM(Number(e.target.value));
            });

            // 5 Playful Macro Buttons
            document.getElementById('macroFreezeBtn').addEventListener('click', () => {
                ensureAudioReady();
                const frozen = synth.toggleFreezeSound();
                const badge = document.getElementById('freezeBufferBadge');
                badge.textContent = frozen ? '❄️ BUFFER FROZEN' : 'NORMAL FLOW';
                badge.classList.toggle('bg-cyan-400', frozen);
                badge.classList.toggle('text-slate-950', frozen);
                setStatus(frozen ? 'FREEZE ENGAGED // Infinite Crystalline Spectral Hold' : 'FREEZE RELEASED // Normal acoustic decay');
            });

            document.getElementById('macroDefrostBtn').addEventListener('click', () => {
                ensureAudioReady();
                synth.triggerDefrostMelt();
                setStatus('DEFROSTING EVERYTHING // Downward pitch melt & evaporating droplets');
            });

            document.getElementById('macroHauntedBtn').addEventListener('click', () => {
                ensureAudioReady();
                synth.triggerHauntedFridge();
                setStatus('POLTERGEIST MODE // Microtonal glass resonance & eerie gasket creaks');
            });

            document.getElementById('macroStrangeBtn').addEventListener('click', () => {
                ensureAudioReady();
                Object.keys(state.params).forEach(k => {
                    setKnobValue(k, Number(Math.random().toFixed(2)));
                });
                const randomInst = state.rng.choice(['compressor', 'freezer', 'icemaker', 'bottles', 'doorseal', 'light']);
                selectInstrument(randomInst);
                synth.triggerInstrumentVoice({ instrument: randomInst, freq: 180 + Math.random() * 520, velocity: 0.95 });
                setStatus(`GENERATED STRANGE NOISE // Mutated ${randomInst.toUpperCase()} DSP matrix`);
            });

            document.getElementById('macroShakeBtn').addEventListener('click', () => {
                ensureAudioReady();
                const chassis = document.getElementById('fridgeChassis');
                chassis.classList.remove('shake-anim');
                void chassis.offsetWidth;
                chassis.classList.add('shake-anim');
                synth.triggerShakeCrash();
                setStatus('SHAKING THE FRIDGE // Rattling glass bottles, ice impact & compressor thud!');
            });

            // Preset Selector & Randomize Knobs
            document.getElementById('presetSelect').addEventListener('change', (e) => {
                ensureAudioReady();
                const p = PRESETS[e.target.value];
                if (!p) return;
                document.getElementById('thermostatSlider').value = p.thermostat;
                document.getElementById('thermostatSlider').dispatchEvent(new Event('input'));
                Object.entries(p.params).forEach(([k, v]) => setKnobValue(k, v));
                synth.triggerInstrumentVoice({ instrument: state.activeInstrument, freq: 261.63, velocity: 0.9 });
                setStatus(`LOADED PRESET: ${e.target.options[e.target.selectedIndex].text}`);
            });

            document.getElementById('randomizeKnobsBtn').addEventListener('click', () => {
                ensureAudioReady();
                Object.keys(state.params).forEach(k => setKnobValue(k, Number(state.rng.range(0.1, 0.95).toFixed(2))));
                synth.triggerInstrumentVoice({ instrument: state.activeInstrument, freq: 293.66, velocity: 0.9 });
            });

            document.getElementById('triggerTestNoteBtn').addEventListener('click', () => {
                ensureAudioReady();
                synth.triggerInstrumentVoice({ instrument: state.activeInstrument, freq: 261.63, velocity: 0.95 });
            });

            // Octave & Sequencer Controls
            document.getElementById('octaveSelect').addEventListener('change', (e) => {
                state.octave = Number(e.target.value);
            });

            document.getElementById('seqPlayToggleBtn').addEventListener('click', (e) => {
                ensureAudioReady();
                state.seqPlaying = !state.seqPlaying;
                e.currentTarget.textContent = state.seqPlaying ? '⏹ STOP SEQ' : '▶ START SEQ';
                e.currentTarget.classList.toggle('bg-amber-400', state.seqPlaying);
                e.currentTarget.classList.toggle('bg-cyan-400', !state.seqPlaying);
            });

            document.getElementById('bpmSlider').addEventListener('input', (e) => {
                state.bpm = Number(e.target.value);
                document.getElementById('bpmReadout').textContent = `${state.bpm} BPM`;
                startSequencerLoop();
            });

            document.getElementById('densitySlider').addEventListener('input', (e) => {
                state.density = Number(e.target.value);
                document.getElementById('densityReadout').textContent = `${state.density}%`;
            });

            // FX Sliders
            document.getElementById('fxDelaySlider').addEventListener('input', (e) => {
                state.fx.delayFeedback = Number(e.target.value) / 100;
                document.getElementById('delayValText').textContent = `${e.target.value}%`;
                if (synth.delayFeedbackNode && synth.ctx) {
                    synth.delayFeedbackNode.gain.setTargetAtTime(state.fx.delayFeedback, synth.ctx.currentTime, 0.04);
                }
            });

            document.getElementById('fxDelayTimeSlider').addEventListener('input', (e) => {
                const ms = Number(e.target.value);
                state.fx.delayTime = ms / 1000;
                document.getElementById('delayTimeText').textContent = `${ms} ms`;
                if (synth.delayL && synth.delayR && synth.ctx) {
                    synth.delayL.delayTime.setTargetAtTime(state.fx.delayTime, synth.ctx.currentTime, 0.05);
                    synth.delayR.delayTime.setTargetAtTime(state.fx.delayTime * 1.33, synth.ctx.currentTime, 0.05);
                }
            });

            document.getElementById('fxReverbSlider').addEventListener('input', (e) => {
                state.fx.reverbMix = Number(e.target.value) / 100;
                document.getElementById('reverbValText').textContent = `${e.target.value}%`;
                if (synth.reverbWetGain && synth.ctx) {
                    synth.reverbWetGain.gain.setTargetAtTime(state.fx.reverbMix, synth.ctx.currentTime, 0.04);
                }
            });

            // Computer Keyboard Polyphonic Input
            const keyMap = { A: 0, W: 1, S: 2, E: 3, D: 4, F: 5, T: 6, G: 7, Y: 8, H: 9, U: 10, J: 11, K: 12 };
            window.addEventListener('keydown', (e) => {
                if (e.repeat || e.target.tagName === 'INPUT') return;
                const upper = e.key.toUpperCase();
                if (keyMap[upper] !== undefined) {
                    const semi = keyMap[upper];
                    const btn = document.querySelector(`.synth-key[data-kbd="${upper}"]`);
                    triggerSemitone(semi, btn);
                }
            });

            // Web MIDI API Support
            if (navigator.requestMIDIAccess) {
                navigator.requestMIDIAccess().then(midi => {
                    const midiTxt = document.getElementById('midiStatusText');
                    const bindInputs = () => {
                        let count = 0;
                        midi.inputs.forEach(input => {
                            count++;
                            input.onmidimessage = (msg) => {
                                const [cmd, note, vel] = msg.data;
                                if ((cmd & 0xf0) === 0x90 && vel > 0) {
                                    ensureAudioReady();
                                    const freq = 440 * Math.pow(2, (note - 69) / 12);
                                    synth.triggerInstrumentVoice({
                                        instrument: state.activeInstrument,
                                        freq,
                                        velocity: vel / 127
                                    });
                                }
                            };
                        });
                        if (midiTxt) midiTxt.textContent = count > 0 ? `MIDI: ${count} DEV` : 'MIDI: READY';
                    };
                    bindInputs();
                    midi.onstatechange = bindInputs;
                }).catch(() => {});
            }

            // =========================================================================
            // 11. WAV EXPORT & BATCH ZIP GENERATION HANDLERS
            // =========================================================================
            document.getElementById('renderWavBtn').addEventListener('click', async () => {
                await ensureAudioReady();
                const bitDepth = Number(document.getElementById('exportBitDepth').value);
                const sampleRate = Number(document.getElementById('exportSampleRate').value);
                const duration = Number(document.getElementById('exportDuration').value);
                const normalize = document.getElementById('exportNormalize').checked;

                const progBox = document.getElementById('exportProgressBox');
                const progBar = document.getElementById('exportProgressBar');
                const progLbl = document.getElementById('exportProgressLabel');

                progBox.classList.remove('hidden');
                progBar.style.width = '45%';
                progLbl.textContent = `Rendering ${bitDepth}-bit / ${(sampleRate / 1000).toFixed(1)}kHz WAV...`;

                try {
                    const wavBlob = await WavStudioExporter.renderOfflinePatch({
                        sampleRate,
                        bitDepth,
                        duration,
                        normalize,
                        seed: state.seed,
                        instrument: state.activeInstrument,
                        params: { ...state.params },
                        thermostat: state.thermostat
                    });

                    progBar.style.width = '100%';
                    const fileName = `FRIDGE_FM_${state.activeInstrument.toUpperCase()}_${bitDepth}bit_${sampleRate}Hz_${state.seed}.wav`;
                    downloadBlob(wavBlob, fileName);
                    progLbl.textContent = `Exported ${fileName}`;
                    setStatus(`EXPORTED VALID ${bitDepth}-BIT WAV // ${fileName}`);
                    setTimeout(() => progBox.classList.add('hidden'), 2400);
                } catch (err) {
                    progLbl.textContent = `Render error: ${err.message}`;
                }
            });

            document.getElementById('batchZipBtn').addEventListener('click', async () => {
                if (typeof JSZip === 'undefined') {
                    setStatus('JSZip library still loading...');
                    return;
                }
                await ensureAudioReady();
                const count = Number(document.getElementById('batchCountSelect').value);
                const bitDepth = Number(document.getElementById('exportBitDepth').value);
                const sampleRate = Number(document.getElementById('exportSampleRate').value);
                const duration = Number(document.getElementById('exportDuration').value);
                const normalize = document.getElementById('exportNormalize').checked;

                const progBox = document.getElementById('exportProgressBox');
                const progBar = document.getElementById('exportProgressBar');
                const progLbl = document.getElementById('exportProgressLabel');
                progBox.classList.remove('hidden');

                const zip = new JSZip();
                const instruments = ['compressor', 'freezer', 'icemaker', 'hum', 'bottles', 'defrost', 'doorseal', 'light'];
                const metadata = {
                    synthesizer: 'FRIDGE FM — Model 1958-DSP',
                    generatedAt: new Date().toISOString(),
                    baseSeed: state.seed,
                    sampleRate,
                    bitDepth,
                    durationSeconds: duration,
                    normalized: normalize,
                    samples: []
                };

                for (let i = 0; i < count; i++) {
                    const pct = Math.round(((i + 1) / count) * 100);
                    progBar.style.width = `${pct}%`;
                    const inst = instruments[i % instruments.length];
                    const itemSeed = `${state.seed}-BATCH-${i + 1}`;
                    progLbl.textContent = `Synthesizing ${i + 1}/${count}: ${inst.toUpperCase()} (${bitDepth}-bit)...`;

                    // Yield to UI thread
                    await new Promise(r => setTimeout(r, 15));

                    const itemRng = new SeededRandom(itemSeed);
                    const itemParams = {
                        pitch: Number(itemRng.range(0.2, 0.85).toFixed(2)),
                        timbre: Number(itemRng.range(0.25, 0.95).toFixed(2)),
                        modDepth: Number(itemRng.range(0.15, 0.9).toFixed(2)),
                        resonance: Number(itemRng.range(0.2, 0.88).toFixed(2)),
                        decay: Number(itemRng.range(0.25, 0.9).toFixed(2)),
                        drive: Number(itemRng.range(0.05, 0.65).toFixed(2)),
                        stereo: Number(itemRng.range(0.4, 0.95).toFixed(2)),
                        cryoMix: Number(itemRng.range(0.2, 0.95).toFixed(2))
                    };
                    const itemThermo = Math.round(itemRng.range(15, 98));

                    const wavBlob = await WavStudioExporter.renderOfflinePatch({
                        sampleRate,
                        bitDepth,
                        duration,
                        normalize,
                        seed: itemSeed,
                        instrument: inst,
                        params: itemParams,
                        thermostat: itemThermo
                    });

                    const fname = `${String(i + 1).padStart(2, '0')}_FRIDGE_FM_${inst.toUpperCase()}_${bitDepth}bit.wav`;
                    zip.file(fname, wavBlob);
                    metadata.samples.push({
                        file: fname,
                        instrument: inst,
                        seed: itemSeed,
                        thermostat: itemThermo,
                        params: itemParams
                    });
                }

                zip.file('FRIDGE_FM_PACK_METADATA.json', JSON.stringify(metadata, null, 2));
                progLbl.textContent = 'Compressing Sample Pack ZIP...';
                const zipBlob = await zip.generateAsync({ type: 'blob' });
                const zipName = `FRIDGE_FM_${count}_SAMPLE_PACK_${bitDepth}bit_${state.seed}.zip`;
                downloadBlob(zipBlob, zipName);
                progLbl.textContent = `Downloaded ${zipName}`;
                setStatus(`BATCH EXPORT COMPLETE // ${count}Lossless WAVs + Metadata in ${zipName}`);
                setTimeout(() => progBox.classList.add('hidden'), 3000);
            });

            // Save / Load JSON Patch
            document.getElementById('savePresetJsonBtn').addEventListener('click', () => {
                const patch = {
                    name: `FRIDGE_FM_${state.seed}`,
                    seed: state.seed,
                    thermostat: state.thermostat,
                    activeInstrument: state.activeInstrument,
                    params: state.params,
                    fx: state.fx,
                    bottleLevels: state.bottleLevels,
                    seqSteps: state.seqSteps,
                    bpm: state.bpm
                };
                const blob = new Blob([JSON.stringify(patch, null, 2)], { type: 'application/json' });
                downloadBlob(blob, `FRIDGE_FM_PATCH_${state.seed}.json`);
                setStatus('SAVED SYNTH PATCH TO .JSON');
            });

            document.getElementById('loadPresetInput').addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const patch = JSON.parse(ev.target.result);
                        if (patch.seed) {
                            state.seed = patch.seed;
                            document.getElementById('seedInput').value = patch.seed;
                        }
                        if (patch.thermostat !== undefined) {
                            document.getElementById('thermostatSlider').value = patch.thermostat;
                            document.getElementById('thermostatSlider').dispatchEvent(new Event('input'));
                        }
                        if (patch.activeInstrument) selectInstrument(patch.activeInstrument);
                        if (patch.params) {
                            Object.entries(patch.params).forEach(([k, v]) => setKnobValue(k, Number(v)));
                        }
                        if (patch.bottleLevels && Array.isArray(patch.bottleLevels)) {
                            state.bottleLevels = patch.bottleLevels;
                            buildBottleRack();
                        }
                        setStatus(`LOADED PATCH: ${file.name}`);
                    } catch (err) {
                        setStatus('INVALID JSON PATCH FILE');
                    }
                };
                reader.readAsText(file);
            });
        }

        function updateContinuousButtonsUI() {
            // Compressor UI
            const compBtn = document.getElementById('compressorToggleBtn');
            const compTag = document.getElementById('compressorStatusTag');
            const compCore = document.getElementById('compressorCoreVisual');
            compBtn.textContent = state.compressorRunning ? 'STOP' : 'ENGAGE';
            compBtn.classList.toggle('bg-amber-400', state.compressorRunning);
            compBtn.classList.toggle('text-slate-950', state.compressorRunning);
            compTag.textContent = state.compressorRunning ? 'RUNNING' : 'IDLE';
            compCore.classList.toggle('compressor-active', state.compressorRunning);

            // Hum UI
            const humBtn = document.getElementById('humDroneToggleBtn');
            humBtn.textContent = state.humRunning ? 'ON' : 'OFF';
            humBtn.classList.toggle('bg-emerald-400', state.humRunning);
            humBtn.classList.toggle('text-slate-950', state.humRunning);

            // Defrost Hiss UI
            const hissBtn = document.getElementById('defrostNoiseToggleBtn');
            hissBtn.textContent = state.defrostHissRunning ? 'HISS: ON' : 'HISS: OFF';
            hissBtn.classList.toggle('bg-cyan-400', state.defrostHissRunning);
            hissBtn.classList.toggle('text-slate-950', state.defrostHissRunning);
        }

        function constbulbEffect() {
            const bulb = document.getElementById('bulbVisual');
            bulb.classList.add('scale-125', 'bg-white');
            setTimeout(() => bulb.classList.remove('scale-125', 'bg-white'), 220);
        }

        function downloadBlob(blob, filename) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1500);
        }

        // =========================================================================
        // 12. INITIALIZE APPLICATION ON DOM READY
        // =========================================================================
        buildIceCubeTray();
        buildBottleRack();
        buildRotaryKnobs();
        buildPianoKeyboard();
        buildSequencerGrid();
        initEventListeners();
        startSequencerLoop();
        startVisualizers();
        updateScopeReadout();

    })();
