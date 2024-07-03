import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import cheerio from 'cheerio';

const endpoint = 'https://www.thebroadway.nyc/showcalendar';

interface EventDetails {
  title: string | null;
  date: string | null;
  genre: string;
  time: string | null;
  location: string;
  price: string | null;
  image: string | null;
  excerpt: string | null;
  isFeatured: boolean;
}

let gigzArr: EventDetails[] = [];

const retry = async <T>(fn: () => Promise<T>, retries: number, delay: number): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 1) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return retry(fn, retries - 1, delay);
    } else {
      throw error;
    }
  }
};

const processExcerpt = (excerpt: string | null, link: string | null): string => {
  let formattedExcerpt = '';

  if (excerpt) {
    formattedExcerpt += `<p>${excerpt}</p><br><br><ul><li><a href='${link}'>BUY TICKETS</a></li></ul>`;
  }

  if (link && !excerpt) {
    formattedExcerpt += `<br><br><ul><li><a href='${link}'>BUY TICKETS</a></li></ul>`;
  } else if (!link && !excerpt) {
    formattedExcerpt = '';
  }

  return formattedExcerpt;
};

const formatDateStringForMongoDB = (dateString: string): string => {
  const currentYear = new Date().getFullYear();
  const date = new Date(`${dateString} ${currentYear}`);

  const isoString = date.toISOString();
  const datePart = isoString.split('T')[0];
  const timePart = '00:00:00.000';
  const timezoneOffset = '+00:00';

  return `${datePart}T${timePart}${timezoneOffset}`;
};

const dynamicScrollAndCollectLinks = async (page: Page, selector: string): Promise<{ link: string; imageUrl: string }[]> => {
  let links = new Set<string>();
  try {
    let previousSize = 0;
    let newSize = 0;
    do {
      previousSize = links.size;
      const newLinks = await page.$$eval(selector, elements =>
        elements.map(el => {
          const img = el.closest('article')?.querySelector('img');
          return {
            link: (el as HTMLAnchorElement).href,
            imageUrl: img ? (img as HTMLImageElement).dataset.src || '' : ''
          };
        })
      );
      newLinks.forEach(item => links.add(JSON.stringify(item)));
      newSize = links.size;
      if (newSize > previousSize) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2000);
      }
    } while (newSize > previousSize);
  } catch (error) {
    console.error('Error during dynamic scroll and link collection: ', error);
  }
  return Array.from(links).map(item => JSON.parse(item));
};

const scrapeEventDetails = async (context: BrowserContext, link: string, imageUrl: string): Promise<EventDetails | null> => {
  let eventPage: Page | undefined;
  try {
    eventPage = await retry(
      async () => {
        return await context.newPage();
      },
      3,
      1000
    );

    await eventPage.goto(link, { waitUntil: 'domcontentloaded' });

    let title: string | null = null,
      date: string | null = null,
      time: string | null = null,
      location: string = 'THE BROADWAY',
      price: string | null = null,
      excerpt: string | null = null,
      isFeatured = false,
      ticketLink: string | null = null,
      genre: string = '';

    try {
      title = await eventPage.$eval('h1', el => el.textContent?.trim() || null);
    } catch (err) {
      console.error(`Error finding title on ${link}: `, err);
    }

    try {
      date = await eventPage.$eval('time', el => el.textContent?.trim() || null);
    } catch (err) {
      console.error(`Error finding date on ${link}: `, err);
    }

    try {
      time = await eventPage.$eval('time.event-time-localized-start', el => el.textContent?.trim() || null);
    } catch (err) {
      console.error(`Error finding time on ${link}: `, err);
      try {
        time = await eventPage.$eval(
          'body > div:nth-child(1) > main:nth-child(3) > article:nth-child(1) > section:nth-child(1) > div:nth-child(2) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > article:nth-child(2) > div:nth-child(1) > ul:nth-child(2) > li:nth-child(1) > span:nth-child(2) > time:nth-child(1)',
          el => el.textContent?.trim() || null
        );
      } catch (err) {
        console.error(`Error finding time with backup selector on ${link}: `, err);
      }
    }

    try {
      price = await eventPage.$eval(
        'body > div:nth-child(1) > main:nth-child(3) > article:nth-child(1) > section:nth-child(1) > div:nth-child(2) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > article:nth-child(2) > div:nth-child(2) > div:nth-child(1) > div:nth-child(1) > div:nth-child(1) > div:nth-child(3) > div:nth-child(1) > div:nth-child(1) > p:nth-child(3)',
        el => el.textContent?.trim() || 'check details'
      );
    } catch (err) {
      console.error(`Error finding price on ${link}: `, err);
    }

    try {
      excerpt = await eventPage.$eval('p.preFlex.flexIn strong', el => el.textContent?.trim() || null);
    } catch (err) {
      console.error(`Error finding excerpt on ${link}: `, err);
    }

    const genreKeywords: { [key: string]: string[] } = {
      'black metal': ['black metal'],
      metal: ['metal'],
      'nu metal': ['nu metal'],
      punk: ['punk'],
      'post punk': ['post punk', 'post - punk', 'post-punk'],
      'stoner rock': ['stoner rock'],
      'post rock': ['post rock', 'post - rock', 'post-rock'],
      rock: ['rock'],
      edm: ['edm'],
      synth: ['synth'],
      industrial: ['industrial'],
      pop: ['pop'],
      'hip-hop': ['hip-hop', 'hip hop'],
      oi: ['oi'],
      emo: ['emo'],
      other: ['other']
    };

    const findGenre = (text: string): string => {
      text = text.toLowerCase();
      for (const [genre, keywords] of Object.entries(genreKeywords)) {
        if (keywords.some(keyword => text.includes(keyword))) {
          return genre;
        }
      }
      return '¯\\_(ツ)_/¯';
    };

    genre = findGenre(excerpt || '');

    try {
      ticketLink = await eventPage.$eval(
        '.sqs-block-button-element--medium.sqs-button-element--primary.sqs-block-button-element',
        el => (el as HTMLAnchorElement).href
      );
    } catch (err) {
      console.error(`Error finding ticket link on ${link}: `, err);
    }

    date = formatDateStringForMongoDB(date || '');
    excerpt = processExcerpt(excerpt, ticketLink);

    await eventPage.close();

    return {
      title,
      date,
      genre,
      time,
      location,
      price,
      image: imageUrl,
      excerpt,
      isFeatured
    };
  } catch (error) {
    if (eventPage) {
      await eventPage.close();
    }
    console.error(`Error scraping details from ${link}: `, error);
    return null;
  }
};

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(endpoint, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('a.eventlist-button.sqs-editable-button.sqs-button-element--primary');

    const eventLinksWithImages = await dynamicScrollAndCollectLinks(
      page,
      'a.eventlist-button.sqs-editable-button.sqs-button-element--primary'
    );
    console.log(`Collected ${eventLinksWithImages.length} event links with images`);

    for (const { link, imageUrl } of eventLinksWithImages) {
      const gigDetails = await scrapeEventDetails(context, link, imageUrl);
      if (gigDetails) gigzArr.push(gigDetails);
    }

    console.log(`Scraped ${gigzArr.length} event details`);
  } catch (error) {
    console.error('Error during the main process: ', error);
  } finally {
    await browser.close();

    if (gigzArr.length) {
      fs.writeFileSync('events.json', JSON.stringify(gigzArr, null, 2), 'utf-8');
      console.log('Data saved to events.json');
    } else {
      console.log('No data to save.');
    }
  }
})();
