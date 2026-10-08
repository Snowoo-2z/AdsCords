import assert from 'node:assert/strict';
import test from 'node:test';

import { euroToCents, progressBar } from './currency.js';
import { campaignPeriodAt } from './campaign-period.js';
import { isDiscordServerLink } from './embeds.js';
import { createMapubDashboardPng } from './mapub-image.js';
import { createEarningsDashboardPng, createOwnerDashboardPng, createProfileDashboardPng } from './account-image.js';

test('euroToCents accepte les formats français et internationaux', () => {
  assert.equal(euroToCents('10'), 1000);
  assert.equal(euroToCents('10,50'), 1050);
  assert.equal(euroToCents('0.15'), 15);
  assert.equal(euroToCents(' 25,00 € '), 2500);
});

test('euroToCents refuse les budgets imprécis, nuls et négatifs', () => {
  assert.equal(euroToCents('0'), null);
  assert.equal(euroToCents('-5'), null);
  assert.equal(euroToCents('1.999'), null);
  assert.equal(euroToCents('pas un prix'), null);
});

test('progressBar reste dans les bornes', () => {
  assert.equal(progressBar(100, 50, 4), '██░░');
  assert.equal(progressBar(100, 200, 4), '████');
  assert.equal(progressBar(100, -1, 4), '░░░░');
});

test('campaignPeriodAt garde des journées complètes de 24 h et répartit exactement le budget', () => {
  const start = '2026-10-08T23:59:00.000Z';
  const atStart = campaignPeriodAt(start, 3, 10, Date.parse(start));
  const onSecondDay = campaignPeriodAt(start, 3, 10, Date.parse('2026-10-10T00:00:00.000Z'));
  const onLastMinute = campaignPeriodAt(start, 3, 10, Date.parse('2026-10-11T23:58:59.999Z'));
  const afterEnd = campaignPeriodAt(start, 3, 10, Date.parse('2026-10-11T23:59:00.000Z'));

  assert.deepEqual(atStart && { day: atStart.dayNumber, budget: atStart.budgetCents }, { day: 1, budget: 4 });
  assert.deepEqual(onSecondDay && { day: onSecondDay.dayNumber, budget: onSecondDay.budgetCents }, { day: 2, budget: 3 });
  assert.deepEqual(onLastMinute && { day: onLastMinute.dayNumber, budget: onLastMinute.budgetCents }, { day: 3, budget: 3 });
  assert.equal(afterEnd, null);
});


test('isDiscordServerLink distingue les invitations Discord des sites web', () => {
  assert.equal(isDiscordServerLink('https://discord.gg/adscords'), true);
  assert.equal(isDiscordServerLink('https://discord.com/invite/adscords'), true);
  assert.equal(isDiscordServerLink('https://example.com/discord.gg'), false);
});


test('createMapubDashboardPng produit une image PNG Discord', () => {
  const image = createMapubDashboardPng([]);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(image.length > 1_000);
});

test('createMapubDashboardPng accepte une campagne sans durée', () => {
  const now = new Date().toISOString();
  const image = createMapubDashboardPng([{
    id: '12345678-1234-4234-9234-123456789abc',
    ownerDiscordId: '1554498783172235345',
    destinationUrl: 'https://example.com',
    description: 'Campagne sans date de fin',
    mediaUrl: null,
    useEmbed: true,
    rewardType: 'bonus',
    durationDays: 0,
    startsAt: now,
    endsAt: null,
    initialCreditsCents: 1_000,
    creditsRemainingCents: 1_000,
    clickCostCents: 10,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    uniqueClicks: 0
  }]);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('les tableaux de gains et de profil produisent des PNG Discord', () => {
  const earnings = createEarningsDashboardPng(
    { cashMilliCents: 3_000, bonusMilliCents: 7_000, paidClicks: 1, guilds: [] },
    new Map()
  );
  const profile = createProfileDashboardPng({
    completedCampaigns: 1,
    completedCampaignClicks: 2,
    completedCampaignSpendCents: 10,
    completedBonusCampaigns: 0,
    serverEarnings: { cashMilliCents: 3_000, bonusMilliCents: 0, paidClicks: 1, guilds: [] },
    bonusWalletMilliCents: 7_000
  });
  const owner = createOwnerDashboardPng({
    platformCashMilliCents: 7_000,
    serverCashMilliCents: 3_000,
    serverBonusMilliCents: 7_000,
    paidClicks: 2
  });
  for (const image of [earnings, profile, owner]) {
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(image.length > 1_000);
  }
});
