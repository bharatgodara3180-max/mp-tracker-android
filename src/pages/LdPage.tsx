/**
 * L&D login: only two things - add an employee (ID + name) and enrol the face. Nothing else is shown;
 * the server also refuses every other call for this role.
 */
import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { GateEnrolSheet } from '../components/GateEnrol';
import { Button } from '../components/ui';

export default function LdPage() {
  const { profile, signOut } = useAuth();
  const [open, setOpen] = useState(true);
  return (
    <section className="panel" style={{ maxWidth: 520, margin: '24px auto', textAlign: 'center' }}>
      <h3>L&amp;D — Employee &amp; Face enrol</h3>
      <p className="muted small">{profile?.full_name}</p>
      <div className="row gap" style={{ justifyContent: 'center', marginTop: 12 }}>
        <Button variant="primary" onClick={() => setOpen(true)}>Employee add / Face enrol</Button>
        <Button variant="ghost" onClick={() => signOut()}>Logout</Button>
      </div>
      {open && <GateEnrolSheet onClose={() => setOpen(false)} />}
    </section>
  );
}
