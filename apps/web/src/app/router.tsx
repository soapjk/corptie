import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { PairingPage } from "../features/pairing/PairingPage";
import { AttentionPage } from "../features/attention/AttentionPage";
import { SessionPage } from "../features/sessions/SessionPage";
import { SessionsPage } from "../features/sessions/SessionsPage";
import { NewSessionPage } from "../features/sessions/NewSessionPage";
import { CollaborationPage } from "../features/collaboration/CollaborationPage";
import { DeviceSettingsPage } from "../features/settings/DeviceSettingsPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/attention" replace /> },
      { path: "attention", element: <AttentionPage /> },
      { path: "sessions", element: <SessionsPage /> },
      { path: "sessions/new", element: <NewSessionPage /> },
      { path: "sessions/:sessionId", element: <SessionPage /> },
      { path: "collaboration", element: <CollaborationPage /> },
      { path: "settings", element: <DeviceSettingsPage /> }
    ]
  },
  { path: "/pair", element: <PairingPage /> }
]);
