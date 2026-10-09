"""WebSocket support for real-time progress updates.

Usage in app.py:
    from websocket_support import WebSocketManager, ProgressTracker

    ws_manager = WebSocketManager()

    @app.websocket("/ws/{client_id}")
    async def websocket_endpoint(websocket: WebSocket, client_id: str):
        await ws_manager.connect(websocket, client_id)
"""

from __future__ import annotations

import inspect
from typing import Dict, Optional, Callable, Awaitable, Any
from fastapi import WebSocket
import logging

logger = logging.getLogger(__name__)


class WebSocketManager:
    """Manages WebSocket connections for real-time progress updates."""

    def __init__(self):
        # client_id -> WebSocket connection
        self.active_connections: Dict[str, WebSocket] = {}
        # session_id -> client_id mapping
        self.session_clients: Dict[str, str] = {}
        # Optional callback for persisting progress to job state.
        self.progress_callback: Optional[
            Callable[[str, int, str], Optional[Awaitable[Any]]]
        ] = None

    def set_progress_callback(
        self,
        callback: Optional[Callable[[str, int, str], Optional[Awaitable[Any]]]],
    ):
        """Register a callback invoked on every progress update."""
        self.progress_callback = callback

    async def connect(self, websocket: WebSocket, client_id: str):
        """Accept and register a WebSocket connection.

        Args:
            websocket: WebSocket connection
            client_id: Unique client identifier
        """
        await websocket.accept()
        self.active_connections[client_id] = websocket
        logger.info(f"WebSocket connected: client_id={client_id}")

        # Send welcome message
        await self.send_personal_message(
            {"type": "connected", "client_id": client_id},
            client_id
        )

    def disconnect(self, client_id: str):
        """Remove a WebSocket connection.

        Args:
            client_id: Client identifier to disconnect
        """
        if client_id in self.active_connections:
            del self.active_connections[client_id]
            logger.info(f"WebSocket disconnected: client_id={client_id}")

        # Clean up session mappings
        sessions_to_remove = [
            sid for sid, cid in self.session_clients.items()
            if cid == client_id
        ]
        for sid in sessions_to_remove:
            del self.session_clients[sid]

    def register_session(self, session_id: str, client_id: str):
        """Associate a session with a client for progress tracking.

        Args:
            session_id: Report generation session ID
            client_id: Client's WebSocket ID
        """
        self.session_clients[session_id] = client_id
        logger.debug(f"Registered session {session_id} -> client {client_id}")

    async def send_personal_message(self, message: dict, client_id: str):
        """Send a message to a specific client.

        Args:
            message: Message data (will be JSON-encoded)
            client_id: Target client ID
        """
        if client_id in self.active_connections:
            try:
                websocket = self.active_connections[client_id]
                await websocket.send_json(message)
            except Exception as e:
                logger.error(f"Failed to send message to {client_id}: {e}")
                self.disconnect(client_id)

    async def send_progress_update(
        self,
        session_id: str,
        progress: int,
        message: str,
        details: Optional[dict] = None
    ):
        """Send progress update for a specific session.

        Args:
            session_id: Report generation session ID
            progress: Progress percentage (0-100)
            message: Progress message
            details: Optional additional details
        """
        callback = self.progress_callback
        if callback:
            try:
                maybe_awaitable = callback(session_id, progress, message)
                if inspect.isawaitable(maybe_awaitable):
                    await maybe_awaitable
            except Exception as e:
                logger.warning(
                    "Progress callback failed: session=%s progress=%s error=%s",
                    session_id,
                    progress,
                    e,
                )

        client_id = self.session_clients.get(session_id)
        if not client_id:
            logger.debug(f"No client registered for session {session_id}. Registered sessions: {list(self.session_clients.keys())}")
            return

        payload = {
            "type": "progress",
            "session_id": session_id,
            "progress": progress,
            "message": message,
            "details": details or {}
        }

        logger.info(f"Sending progress update: session={session_id}, client={client_id}, progress={progress}%, message={message}")
        await self.send_personal_message(payload, client_id)

    async def send_completion(
        self,
        session_id: str,
        result: dict,
        success: bool = True
    ):
        """Send completion notification.

        Args:
            session_id: Report generation session ID
            result: Generation result data
            success: Whether generation succeeded
        """
        client_id = self.session_clients.get(session_id)
        if not client_id:
            return

        payload = {
            "type": "completed" if success else "failed",
            "session_id": session_id,
            "result": result
        }

        await self.send_personal_message(payload, client_id)

        # Clean up session mapping
        if session_id in self.session_clients:
            del self.session_clients[session_id]

    async def broadcast(self, message: dict):
        """Broadcast a message to all connected clients.

        Args:
            message: Message data to broadcast
        """
        disconnected = []
        for client_id, websocket in self.active_connections.items():
            try:
                await websocket.send_json(message)
            except Exception as e:
                logger.error(f"Broadcast failed for {client_id}: {e}")
                disconnected.append(client_id)

        # Clean up disconnected clients
        for client_id in disconnected:
            self.disconnect(client_id)


class ProgressTracker:
    """Context manager for tracking and reporting progress via WebSocket.

    Usage:
        async with ProgressTracker(ws_manager, session_id, total_steps=10) as tracker:
            await tracker.update(1, "Processing data...")
            # ... do work
            await tracker.update(5, "Generating slides...")
            # ... more work
    """

    def __init__(
        self,
        ws_manager: WebSocketManager,
        session_id: str,
        total_steps: int = 100
    ):
        """Initialize progress tracker.

        Args:
            ws_manager: WebSocket manager instance
            session_id: Session to track
            total_steps: Total number of steps (for calculating percentage)
        """
        self.ws_manager = ws_manager
        self.session_id = session_id
        self.total_steps = total_steps
        self.current_step = 0

    async def __aenter__(self):
        """Start tracking."""
        await self.update(0, "Starting generation...")
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Finish tracking."""
        if exc_type is None:
            await self.update(self.total_steps, "Completed!")
        return False

    async def update(self, step: int, message: str, details: Optional[dict] = None):
        """Update progress.

        Args:
            step: Current step number
            message: Progress message
            details: Optional additional details
        """
        self.current_step = step
        progress = int((step / self.total_steps) * 100)

        await self.ws_manager.send_progress_update(
            self.session_id,
            progress,
            message,
            details
        )

    async def increment(self, message: str, details: Optional[dict] = None):
        """Increment progress by 1 step.

        Args:
            message: Progress message
            details: Optional additional details
        """
        await self.update(self.current_step + 1, message, details)


# Example integration with report generation
async def generate_report_with_progress(
    ws_manager: WebSocketManager,
    session_id: str,
    input_id: str,
    template_id: str
):
    """Example: Generate report with WebSocket progress updates.

    This shows how to integrate ProgressTracker into the generation flow.
    """
    total_slides = 10  # Get from template descriptor

    async with ProgressTracker(ws_manager, session_id, total_steps=total_slides + 2) as tracker:
        # Step 1: Load data
        await tracker.update(1, "Loading input data...")
        # ... load data

        # Step 2: Initialize LLM
        await tracker.update(2, "Initializing AI generation...")
        # ... initialize

        # Steps 3-12: Generate each slide
        for slide_no in range(1, total_slides + 1):
            await tracker.update(
                slide_no + 2,
                f"Generating slide {slide_no}/{total_slides}...",
                {"slide_no": slide_no}
            )
            # ... generate slide

        # Final step handled by __aexit__
