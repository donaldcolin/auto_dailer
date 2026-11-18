// Draws each dialer screen from store state, so a name left behind by the split fails here, not on a phone.
import { Animated } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { useDialer } from '../../lib/dialerStore';
import ListScreen from '../ListScreen';
import CallScreen from '../CallScreen';
import MarkScreen from '../MarkScreen';

jest.mock('../../modules/dialer', () => ({ openBringToFrontSettings: () => {} }));
jest.mock('../../ActivityForm', () => () => null);
jest.mock('@expo/vector-icons/Ionicons', () => () => null); // its font loader needs native assets

const lead = { prospectId: 'a', name: 'Amulya Gowda', phone: '+91-7406181238', stage: 'New Lead',
  details: [{ label: 'Source', value: 'Unknown' }, { label: 'Location', value: 'Karnataka' }],
  calls: 3, picked: 1, followUp: { dueAt: '2026-11-15T11:30:00.000Z' } };
const flow = { pickView: () => {}, loadForm: () => {}, openOnLaptop: () => {}, submit: () => {} };
const form = { name: 'Auto Dailer - BDA activity', connected: { schema: 'Status', reason: 'r' }, fields: [{ schema: 'r', dependent: { No: ['Did not pick'] } }] };

beforeEach(() => useDialer.setState(useDialer.getInitialState(), true));

test('list: rows, follow-up label and chips draw', async () => {
  useDialer.setState({ phase: 'idle', view: 'own', views: [{ id: 'own', name: 'My leads', count: 1 }, { id: 'v', name: 'Leads assigned today', count: 0 }],
    queueInfo: { count: 1, source: 'own', rule: null, leads: [lead], upcoming: [] } });
  await render(<ListScreen flow={flow} granted filesAccess canFront onRecordings={() => {}} />);
  expect(screen.getByText('Amulya Gowda')).toBeTruthy();
  expect(screen.getByText('Overdue')).toBeTruthy();
  expect(screen.getByText('Leads assigned today')).toBeTruthy();
});

test('countdown: name, location tag and follow-up band draw', async () => {
  useDialer.setState({ phase: 'countdown', lead });
  await render(<CallScreen status="Calling in 5" histories={{}} countdownBar={new Animated.Value(1)} />);
  expect(screen.getByText('Amulya Gowda')).toBeTruthy();
  expect(screen.getByText('Karnataka')).toBeTruthy();
  expect(screen.getByText(/^Follow-up due/)).toBeTruthy();
});

test('loading: the skeleton draws', async () => {
  useDialer.setState({ phase: 'loading' });
  await render(<CallScreen status="Next lead" histories={{}} countdownBar={new Animated.Value(1)} />);
  expect(screen.getByLabelText('Loading the next lead')).toBeTruthy();
});

test("mark: the reason list draws for a call that didn't connect", async () => {
  useDialer.setState({ phase: 'reason', lead, form });
  await render(<MarkScreen flow={flow} status="Not answered" histories={{}} />);
  expect(screen.getByText("Why didn't it connect?")).toBeTruthy();
  expect(screen.getByText('Did not pick')).toBeTruthy();
});
