"""Arrow flight-tracking DataFlash parser service.

Python + pymavlink. Emits flight_log_summary / flight_log_series /
param_snapshots rows and a sanitized (location-stripped) .bin copy.
"""

__version__ = "0.1.0"
