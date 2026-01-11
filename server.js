const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'TrackMarket Scraper' });
});

// Scrape TrackMan URL
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  
  if (!url || !url.includes('trackman')) {
    return res.status(400).json({ error: 'Invalid TrackMan URL' });
  }

  let browser;
  try {
    console.log('Scraping URL:', url);
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // Navigate to the TrackMan report
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for data to load
    await page.waitForSelector('table', { timeout: 15000 }).catch(() => {});
    
    // Give extra time for dynamic content
    await new Promise(r => setTimeout(r, 3000));

    // Extract data from the page
    const data = await page.evaluate(() => {
      const result = {
        club: null,
        date: null,
        shots: [],
        averages: null
      };

      // Try to find club name - look for common patterns
      const clubSelectors = [
        '[class*="club"]',
        '[class*="Club"]',
        'h2', 'h3', 'h4',
        '[class*="title"]'
      ];
      
      for (const sel of clubSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent.trim();
          const clubMatch = text.match(/(Driver|Wood|\d+\s*Iron|\d+i|PW|SW|GW|LW|Pitching|Sand|Gap|Lob|Wedge|\d+°)/i);
          if (clubMatch) {
            result.club = text;
            break;
          }
        }
      }

      // Try to find date
      const dateMatch = document.body.textContent.match(/(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        result.date = dateMatch[1];
      }

      // Find all tables and extract data
      const tables = document.querySelectorAll('table');
      
      for (const table of tables) {
        const rows = table.querySelectorAll('tr');
        
        for (const row of rows) {
          const cells = row.querySelectorAll('td, th');
          if (cells.length >= 6) {
            const rowData = Array.from(cells).map(c => c.textContent.trim());
            
            // Check if this looks like shot data (first cell is a number)
            const firstVal = parseFloat(rowData[0]);
            if (!isNaN(firstVal) && firstVal > 0 && firstVal < 500) {
              // This looks like a data row
              // Try to parse based on typical TrackMan column order
              const shot = {
                total: parseFloat(rowData[0]) || parseFloat(rowData[1]),
                carry: parseFloat(rowData[1]) || parseFloat(rowData[2]),
                spin: parseFloat(rowData[2]) || parseFloat(rowData[3]),
                smash: parseFloat(rowData[3]) || parseFloat(rowData[4]),
                launch: parseFloat(rowData[4]) || parseFloat(rowData[5]),
                ballSpeed: parseFloat(rowData[5]) || parseFloat(rowData[6]),
                clubSpeed: parseFloat(rowData[6]) || parseFloat(rowData[7]),
                height: parseFloat(rowData[7]) || parseFloat(rowData[8]),
                faceToPath: parseFloat(rowData[8]) || parseFloat(rowData[9]),
                landingAngle: parseFloat(rowData[9]) || parseFloat(rowData[10])
              };
              
              // Only add if we have reasonable values
              if (shot.carry > 20 && shot.carry < 400) {
                result.shots.push(shot);
              }
            }
            
            // Check for averages row
            if (rowData[0]?.toLowerCase().includes('average') || rowData[0]?.toLowerCase().includes('avg')) {
              result.averages = {
                total: parseFloat(rowData[1]),
                carry: parseFloat(rowData[2]),
                spin: parseFloat(rowData[3]),
                smash: parseFloat(rowData[4]),
                launch: parseFloat(rowData[5]),
                ballSpeed: parseFloat(rowData[6]),
                clubSpeed: parseFloat(rowData[7])
              };
            }
          }
        }
      }

      // If no table found, try to scrape any visible numbers
      if (result.shots.length === 0) {
        // Look for data in any structured format
        const allText = document.body.innerText;
        const lines = allText.split('\n');
        
        for (const line of lines) {
          const nums = line.match(/[\d.]+/g);
          if (nums && nums.length >= 6) {
            const values = nums.map(n => parseFloat(n));
            // Check if this looks like shot data
            if (values[0] > 50 && values[0] < 350 && values[1] > 50 && values[1] < 350) {
              result.shots.push({
                total: values[0],
                carry: values[1],
                spin: values[2],
                smash: values[3],
                launch: values[4],
                ballSpeed: values[5],
                clubSpeed: values[6] || 0,
                height: values[7] || 0,
                faceToPath: values[8] || 0,
                landingAngle: values[9] || 0
              });
            }
          }
        }
      }

      return result;
    });

    await browser.close();

    // Calculate stats if we have shots
    if (data.shots.length > 0) {
      const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
      const med = arr => {
        const s = [...arr].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      };
      const std = arr => {
        const m = avg(arr);
        return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
      };

      data.stats = {
        shotCount: data.shots.length,
        carry: Math.round(med(data.shots.map(s => s.carry))),
        total: Math.round(med(data.shots.map(s => s.total))),
        ballSpeed: Math.round(avg(data.shots.map(s => s.ballSpeed))),
        clubSpeed: Math.round(avg(data.shots.map(s => s.clubSpeed))),
        launch: parseFloat(avg(data.shots.map(s => s.launch)).toFixed(1)),
        spin: Math.round(avg(data.shots.map(s => s.spin))),
        smash: parseFloat(avg(data.shots.map(s => s.smash)).toFixed(2)),
        height: Math.round(avg(data.shots.map(s => s.height))),
        dispersion: Math.round(std(data.shots.map(s => s.carry)))
      };
    }

    console.log('Scraped data:', JSON.stringify(data, null, 2));
    res.json(data);

  } catch (error) {
    console.error('Scraping error:', error);
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`TrackMarket scraper running on port ${PORT}`);
});
