/** Tailwind build for the bonos designer page only (pottery-gym itself uses the Tailwind CDN). */
const path = require('path');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, '../bonos-designer.html'),
    path.join(__dirname, '**/*.{js,ts,jsx,tsx}')
  ],
  theme: {
    extend: {}
  },
  plugins: []
};
