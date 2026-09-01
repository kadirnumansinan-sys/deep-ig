import { Studio } from '@/components/studio';
import { AuthGate } from '@/components/auth-gate';

export default function Home() {
  return <AuthGate><Studio /></AuthGate>;
}
