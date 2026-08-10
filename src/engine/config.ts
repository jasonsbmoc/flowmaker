export interface Config {
  playing: boolean;
  ink: string;
  paper: string;
  length: number;
  smear: number;
  soft: number;
  angle: number;
  turbulence: number;
  flow: number;
  flowScale: number;
  flowDrift: number;
  detail: number;
  frequency: number;
  intensity: number;
  speed: number;
  seed: number;
  toneVariance: number;
  edgeRough: number;
  grain: boolean;
  grainAmt: number;
  grainSpeed: number;
}

export const cfg: Config = {
  playing: true,
  ink: '#92C2D9',
  paper: '#F7F4ED',
  length: 5,
  smear: 7,
  soft: 7,
  angle: Math.PI / 4,
  turbulence: 5,
  flow: 4,
  flowScale: 5,
  flowDrift: 4,
  detail: 6,
  frequency: 8,
  intensity: 7,
  speed: 4,
  seed: Math.floor(Math.random() * 1000),
  toneVariance: 3,
  edgeRough: 6,
  grain: true,
  grainAmt: 2,
  grainSpeed: 6,
};

export const SWATCH_PALETTE = [
  '#F7F4ED',
  '#92C2D9',
  '#95BB69',
  '#CDBE6B',
  '#FEAC49',
  '#FE8F46',
];
