@echo off
SET _params=%*
:: pass params to a subroutine
CALL :sub "%_params%"
GOTO :eof
:sub

node .gina %~n1