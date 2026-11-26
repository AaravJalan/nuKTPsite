import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import DirectoryContainer from './DirectoryContainer';
import { ActiveProfileContext } from '../../Framework/ActiveProfileContext';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const profiles = {
  me: { name: 'Current Member', role: 'Member', major: 'Computer Science', year: 'Junior', about: 'Member biography' },
  a: { name: 'Alum Alpha', role: 'Alumni', graduation_year: '2024', majors: ['Data Science'], workplace: 'Acme Labs', instagram: 'alpha', linkedin: 'alpha', about: 'Hidden alumni bio', internships: 'Old internship', email: 'alpha@example.test', resume_link: 'https://example.test/resume', leetcode: { username: 'alpha' } },
  b: { name: 'Alum Beta', role: 'Alumni', graduation_year: '2023', major: 'Economics', workplace: 'Beta Studio', linkedin: 'https://www.linkedin.com/in/beta-user/', instagram: 'https://www.instagram.com/beta-ig/', personal_email: 'beta@personal.test' },
};
let container, root;
beforeEach(() => { HTMLElement.prototype.scrollTo = jest.fn(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
function Harness({ population, initialProfileUid, directory = profiles }) {
  const [activeProfile, setActiveProfile] = useState('me');
  return <ActiveProfileContext.Provider value={{ activeProfile, setActiveProfile }}><DirectoryContainer population={population} fullPubDir={directory} uid="me" initialProfileUid={initialProfileUid} /></ActiveProfileContext.Provider>;
}
test('alumni directory cannot render members and exposes only requested alumni information', () => {
  act(() => root.render(<Harness population="alumni" />));
  expect(container.textContent).toContain('Alumni Directory');
  expect(container.textContent).toContain('Acme Labs');
  expect(container.textContent).toContain('2024');
  expect(container.querySelector('.portal-directory-role[data-role=alumni]').textContent).toBe('2024');
  expect(container.textContent).not.toContain('Current Member');
  for (const hidden of ['Hidden alumni bio', 'Old internship', 'Class Standing', 'Relevant Internships', 'Email', 'Leetcode']) expect(container.textContent).not.toContain(hidden);
  expect(container.querySelector('a[href="https://linkedin.com/in/alpha"]')).not.toBeNull();
  expect(container.querySelector('a[href="https://instagram.com/alpha"]')).not.toBeNull();
  expect(container.querySelector('a[href="https://example.test/resume"]')).not.toBeNull();
  expect(container.textContent).toContain('Resume');
});
test('members directory contains no alumni', () => {
  act(() => root.render(<Harness population="members" />));
  expect(container.textContent).toContain('Current Member');
  expect(container.textContent).not.toContain('Alum Alpha');
  expect(container.textContent).toContain('Member biography');
});
test('alumni search finds workplace and profile selection works after opening a targeted profile', () => {
  act(() => root.render(<Harness population="alumni" initialProfileUid="a" />));
  act(() => [...container.querySelectorAll('.portal-directory-member')].find(b => b.textContent.includes('Alum Beta')).click());
  expect(container.querySelector('article h1').textContent).toBe('Alum Beta');
  expect(container.querySelector('a[href="https://linkedin.com/in/beta-user"]')).not.toBeNull();
  expect(container.querySelector('a[href="https://instagram.com/beta-ig"]')).not.toBeNull();
  expect(container.textContent).toContain('Email');
  expect(container.querySelector('.portal-profile-avatar .portal-avatar-placeholder').textContent).toBe('A');
  const search = container.querySelector('input[type=search]');
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'Acme'); search.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.querySelectorAll('.portal-directory-member')).toHaveLength(1);
  expect(container.querySelector('.portal-directory-member').textContent).toContain('Alum Alpha');
});
test('an empty alumni population gives an empty state instead of a loading screen', () => {
  act(() => root.render(<Harness population="alumni" directory={{ me: profiles.me }} />));
  expect(container.querySelector('[role=status]').textContent).toBe('No alumni to display.');
});
