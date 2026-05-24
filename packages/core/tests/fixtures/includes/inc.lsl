// included file for tests
integer includedValue()
{
#ifdef DEBUG
	return 1;
#else
	return 0;
#endif
}
